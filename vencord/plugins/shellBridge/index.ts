/*
 * ShellBridge – Vencord user plugin for facet
 *
 * Sends Discord events to the Quickshell shell over a Unix socket and runs the actions
 * the shell sends back. Protocol: see quickshell/.config/quickshell/services/DiscordBridge.qml.
 *
 * Events: DMs and mentions, people joining/leaving your voice channel (and channels you
 * watch, see "Watch in shell" in a voice channel's right-click menu), scheduled server
 * events going live, incoming calls and how they ended (answered, declined, missed), your own mute/deafen changes,
 * and for the voice overlay who is in your channel, who is talking and who watches your own stream.
 * Actions: accept/decline call, call back, join a watched channel, leave voice, open channel, toggle mute/deafen,
 * start and stop your Go Live stream with the shell's settings (resolution, frame rate, which apps are heard),
 * for the launcher (d): list contacts, open a DM, call someone, send a DM, reply to the
 * last person you wrote to, and for a notification's reply field: send into a channel.
 *
 * Discord's internal module and event names change now and then; if something stops
 * working, check them first.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { getIntlMessage, insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByCode, findByProps, findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, GuildMemberStore, GuildStore, Menu, MessageStore, NavigationRouter, React, ReadStateStore, RelationshipStore, RestAPI, SelectedChannelStore, UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.ShellBridge as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    watchedChannels: {
        type: OptionType.STRING,
        description: "Voice channel IDs to watch even when you are not in them, comma separated",
        default: ""
    }
});

function watchedChannels(): string[] {
    return settings.store.watchedChannels.split(",").map(id => id.trim()).filter(Boolean);
}

function toggleWatch(channelId: string) {
    const list = watchedChannels();
    settings.store.watchedChannels = (list.includes(channelId)
        ? list.filter(id => id !== channelId)
        : list.concat(channelId)).join(",");
}

// Voice channels (2) and stage channels (13) get "Watch in shell" in their right-click menu
const channelContextMenu: NavContextMenuPatchCallback = (children, { channel }: any) => {
    if (!channel || (channel.type !== 2 && channel.type !== 13))
        return;
    const watching = watchedChannels().includes(channel.id);
    children.push(React.createElement(Menu.MenuItem, {
        id: "shellbridge-watch",
        label: watching ? "Stop watching in shell" : "Watch in shell",
        action: () => toggleWatch(channel.id)
    }));
};

const MediaEngineStore = findStoreLazy("MediaEngineStore");
const VoiceStateStore = findStoreLazy("VoiceStateStore");
// Go Live streams, yours included; only used behind try/catch (see streamState)
const ApplicationStreamingStore = findStoreLazy("ApplicationStreamingStore");
const ChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");
const AudioActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");
const CallActions = findByPropsLazy("stopRinging", "ring");

let commandPoll: ReturnType<typeof setInterval> | undefined;

// Ctrl+Alt+Q types an @ and Ctrl+Alt+E a € on the desktop. Hyprland sends other apps AltGr+key,
// which Chromium on Wayland turns into nothing, so Hyprland passes Ctrl+Alt+key to Vesktop and
// the character is typed here.
const altGrKeys: Record<string, string> = { KeyQ: "@", KeyE: "€" };

function typeAltGr(e: KeyboardEvent) {
    const char = altGrKeys[e.code];
    if (!char || !e.ctrlKey || !e.altKey || e.shiftKey || e.metaKey)
        return;
    e.preventDefault();
    e.stopPropagation();
    // Discord's message box (Slate) ignores execCommand, it takes text through its own dispatch;
    // plain fields (search, settings) still do with execCommand
    if ((document.activeElement as HTMLElement | null)?.getAttribute("role") === "textbox")
        insertTextIntoChatInputBox(char);
    else
        document.execCommand("insertText", false, char);
}

// Calls we already told the shell about, so CALL_UPDATE does not repeat them
const ringingCalls = new Map<string, { caller: string; avatar: string }>();
// Calls declined from the shell; anything else that stops ringing without you joining is missed
const declinedCalls = new Set<string>();
// Scheduled events already announced as started
const startedEvents = new Set<string>();

function displayName(user: any): string {
    return user?.globalName ?? user?.username ?? "someone";
}

// PNG rather than Discord's default WebP, which Qt only reads with an extra image plugin
function asPng(url: string): string {
    return url.replace(/\.webp(\?|$)/, ".png$1");
}

function avatarOf(user: any): string {
    return asPng(user?.getAvatarURL?.(undefined, 128) ?? "");
}

// Group DM: its own icon, otherwise the first member's picture
function groupIcon(channel: any): string {
    if (channel?.icon)
        return `https://cdn.discordapp.com/channel-icons/${channel.id}/${channel.icon}.png?size=128`;
    return avatarOf(UserStore.getUser(channel?.recipients?.[0]));
}

function groupName(channel: any): string {
    if (channel?.name)
        return channel.name;
    const names = (channel?.recipients ?? []).map((id: string) => displayName(UserStore.getUser(id)));
    return names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
}

// Brings the Vesktop window up when the shell opens something in it
function focusWindow() {
    try {
        (window as any).VesktopNative?.win?.focus?.();
    } catch {
        // Not Vesktop
    }
}

function channelName(channelId: string | null | undefined): string {
    const channel = channelId ? ChannelStore.getChannel(channelId) : null;
    return channel?.name || "call";
}

function membersIn(channelId: string): number {
    return Object.keys(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {}).length;
}

// ── Voice overlay: who is in your channel and who is talking ─

// Users whose microphone is open right now (SPEAKING), so the overlay can light them up
const speaking = new Set<string>();

// Everyone in your voice channel with their mute, deafen and stream state; an empty
// channelId when you are in none. You come first, the rest by name.
function voiceState() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId)
        return { type: "voice_state", channelId: "", channel: "", guild: "", members: [] };
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel?.guild_id ?? null;
    const me = UserStore.getCurrentUser()?.id;
    const states = Object.values<any>(VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {});
    const members = states.map(state => {
        const user = UserStore.getUser(state.userId);
        const you = state.userId === me;
        return {
            userId: state.userId,
            name: (guildId && GuildMemberStore.getNick?.(guildId, state.userId)) || displayName(user),
            avatar: asPng(user?.getAvatarURL?.(guildId ?? undefined, 64) ?? ""),
            you,
            // Your own state from the media engine: it changes before the voice state does
            muted: you ? MediaEngineStore.isSelfMute() : !!(state.selfMute || state.mute),
            deafened: you ? MediaEngineStore.isSelfDeaf() : !!(state.selfDeaf || state.deaf),
            streaming: !!state.selfStream,
            speaking: speaking.has(state.userId)
        };
    }).sort((a, b) => a.you !== b.you ? (a.you ? -1 : 1) : a.name.localeCompare(b.name));
    return {
        type: "voice_state",
        channelId,
        channel: channel?.type === 1 || channel?.type === 3 ? groupName(channel) : channel?.name ?? "call",
        guild: guildId ? GuildStore.getGuild(guildId)?.name ?? "" : "",
        members
    };
}

// Several updates arrive at once when someone joins; one snapshot after them is enough
let voiceTimer: ReturnType<typeof setTimeout> | undefined;
function sendVoiceState() {
    clearTimeout(voiceTimer);
    voiceTimer = setTimeout(() => Native.send(voiceState()), 80);
}

// ── Voice overlay: who watches your own stream ──────────────

// Discord keys a stream "guild:<guildId>:<channelId>:<ownerId>", a DM call "call:<channelId>:<ownerId>"
function streamKey(stream: any): string {
    return stream.guildId && stream.streamType !== "call"
        ? `guild:${stream.guildId}:${stream.channelId}:${stream.ownerId}`
        : `call:${stream.channelId}:${stream.ownerId}`;
}

// Warned once; afterwards the feature just stays off until Discord's names are checked
let streamWarned = false;

// Whether your Go Live stream runs and who watches it, sorted by name. Every store call is
// guarded: ApplicationStreamingStore.getCurrentUserActiveStream() and getViewerIds() are
// Discord internals, a rename makes this report "not live" instead of breaking the bridge.
function streamState() {
    const off = { type: "stream", live: false, viewers: [] as { id: string; name: string; avatar: string }[] };
    try {
        const stream = ApplicationStreamingStore?.getCurrentUserActiveStream?.();
        if (!stream)
            return off;
        // getViewerIds takes the stream object; should it want the key one day, try that too
        let ids = ApplicationStreamingStore.getViewerIds?.(stream);
        if (!Array.isArray(ids))
            ids = ApplicationStreamingStore.getViewerIds?.(streamKey(stream));
        const guildId = stream.guildId ?? null;
        const viewers = (Array.isArray(ids) ? ids as string[] : []).map(id => {
            const user = UserStore.getUser(id);
            return {
                id,
                name: (guildId && GuildMemberStore.getNick?.(guildId, id)) || displayName(user),
                avatar: asPng(user?.getAvatarURL?.(guildId ?? undefined, 64) ?? "")
            };
        }).sort((a, b) => a.name.localeCompare(b.name));
        return { type: "stream", live: true, viewers };
    } catch (e) {
        if (!streamWarned)
            console.warn("[ShellBridge] stream state unavailable, viewers stay off", e);
        streamWarned = true;
        return off;
    }
}

// The store changes for every stream in every channel; only a change of your own state or
// viewer list reaches the shell. lastStream = "" forces the next send (the shell reconnected).
let lastStream = "";
let streamTimer: ReturnType<typeof setTimeout> | undefined;
function sendStreamState() {
    clearTimeout(streamTimer);
    streamTimer = setTimeout(() => {
        const state = streamState();
        const json = JSON.stringify(state);
        if (json === lastStream)
            return;
        lastStream = json;
        Native.send(state);
    }, 80);
}

function sendSelfState() {
    const voice = SelectedChannelStore.getVoiceChannelId();
    Native.send({
        type: "self",
        muted: MediaEngineStore.isSelfMute(),
        deafened: MediaEngineStore.isSelfDeaf(),
        channel: voice ? channelName(voice) : ""
    });
}

// Discord used to send the rung users as `ringing` (ids); now it sends `ongoingRings`, keyed by id
function ringingUsers(ringing: string[] | undefined, ongoingRings: Record<string, unknown> | undefined): string[] {
    return ringing ?? Object.keys(ongoingRings ?? {});
}

function handleCall(channelId: string, ringing: string[] | undefined) {
    const me = UserStore.getCurrentUser()?.id;
    const ringsMe = !!me && (ringing ?? []).includes(me);

    if (ringsMe && !ringingCalls.has(channelId)) {
        const channel = ChannelStore.getChannel(channelId);
        // In a DM the other recipient is the caller; a group call shows the group and its icon
        const user = UserStore.getUser(channel?.recipients?.[0]);
        const info = channel?.type === 3
            ? { caller: groupName(channel), avatar: groupIcon(channel), group: true }
            : { caller: displayName(user), avatar: avatarOf(user), group: false };
        ringingCalls.set(channelId, info);
        Native.send({ type: "call", state: "ringing", ...info, channelId });
    } else if (!ringsMe && ringingCalls.has(channelId)) {
        endCall(channelId);
    }
}

// Ringing stopped: tell the shell whether you answered, declined or missed it.
// Joining updates the voice store a moment after the ringing list, so wait a little.
// Declining inside Discord itself cannot be told apart from the caller hanging up; it shows as missed.
function endCall(channelId: string) {
    const info = ringingCalls.get(channelId);
    if (!info)
        return;
    ringingCalls.delete(channelId);
    setTimeout(() => {
        const reason = SelectedChannelStore.getVoiceChannelId() === channelId ? "accepted"
            : declinedCalls.delete(channelId) ? "declined" : "missed";
        Native.send({ type: "call", state: "ended", reason, ...info, channelId });
    }, 400);
}

type StreamRequest = {
    resolution?: string;
    fps?: string;
    audio?: "none" | "system" | "apps";
    nodes?: Record<string, string>[];
    hint?: "motion" | "detail";
};

let pendingStream: (StreamRequest & { at: number }) | null = null;
let pickerWatch: MutationObserver | undefined;

function vesktop(): any {
    return (window as any).VesktopNative;
}

function streamActions(): { start?: (...a: any[]) => any; stop?: (...a: any[]) => any; } {
    const out: { start?: any; stop?: any; } = {};
    try {
        const mod = findByProps("startStream", "stopStream");
        out.start = mod?.startStream;
        out.stop = mod?.stopStream;
    } catch { /* not under these names */ }
    try {
        out.start ??= findByCode('type:"STREAM_START"');
    } catch { /* not found */ }
    try {
        out.stop ??= findByCode('type:"STREAM_STOP"');
    } catch { /* not found */ }
    return out;
}

function streamStep(step: string) {
    Native.send({ type: "stream_log", step });
}

function streamError(error: string) {
    console.warn("[ShellBridge] stream:", error);
    Native.send({ type: "stream_error", error });
}

async function sendAudioSources() {
    try {
        const answer = await vesktop()?.virtmic?.list();
        if (!answer?.ok)
            return Native.send({ type: "audio_sources", ok: false, list: [] });
        const seen = new Set<string>();
        const list = (answer.targets ?? []).flatMap((node: Record<string, string>) => {
            const name = node["application.name"] || node["node.name"] || "";
            if (!name || seen.has(name))
                return [];
            seen.add(name);
            return [{ name, node }];
        }).sort((a: any, b: any) => a.name.localeCompare(b.name));
        Native.send({ type: "audio_sources", ok: true, list });
    } catch (e) {
        Native.send({ type: "audio_sources", ok: false, list: [], error: String(e) });
    }
}

function applyQuality(request: StreamRequest) {
    const fps = Number(request.fps ?? 30);
    const height = Number(request.resolution ?? 720);
    const width = Math.round(height * 16 / 9);
    const me = UserStore.getCurrentUser()?.id;
    try {
        const conn = [...MediaEngineStore.getMediaEngine().connections].find((c: any) => c.streamUserId === me) as any;
        if (!conn)
            return false;
        const params = conn.videoStreamParameters?.[0];
        if (params) {
            params.maxFrameRate = fps;
            params.maxResolution ??= { width: 0, height: 0 };
            params.maxResolution.width = width;
            params.maxResolution.height = height;
        }
        const track = conn.input?.stream?.getVideoTracks?.()[0];
        if (track) {
            track.contentHint = request.hint ?? "motion";
            track.applyConstraints({
                ...track.getConstraints(),
                frameRate: { min: fps, ideal: fps },
                width: { min: 640, ideal: width, max: width },
                height: { min: 480, ideal: height, max: height },
                advanced: [{ width, height }],
                resizeMode: "none"
            }).catch((e: unknown) => console.warn("[ShellBridge] constraints", e));
        }
        return true;
    } catch (e) {
        console.warn("[ShellBridge] stream quality", e);
        return false;
    }
}

function answerPicker(root: HTMLElement) {
    const request = pendingStream;
    if (!request || Date.now() - request.at > 60000)
        return false;
    const modal = [...root.querySelectorAll<HTMLElement>("[role=dialog]")]
        .find(d => /Screen Share Picker/i.test(d.textContent ?? ""));
    if (!modal)
        return false;
    pendingStream = null;
    streamStep("Vesktop's picker is open, filling it in");
    // Every radio is named "fps": find them by section and value, never by text.
    const sections = [...modal.querySelectorAll<HTMLElement>("[class*='vcd-screen-picker-quality-section']")];
    const choose = (section: HTMLElement | undefined, value: string | undefined, what: string) => {
        if (!value)
            return;
        const input = section?.querySelector<HTMLInputElement>(`input[type=radio][value="${CSS.escape(value)}"]`);
        if (!input) {
            streamStep(`${what} ${value} not found in Vesktop's picker`);
            return;
        }
        if (!input.checked)
            (input.closest("label") ?? input).click();
    };
    choose(sections[0], request.resolution, "resolution");
    choose(sections[1], request.fps, "frame rate");
    choose(sections[2], request.hint ?? "motion", "content type");
    streamStep(`picked ${request.resolution}p, ${request.fps} fps, ${request.hint ?? "motion"} (${sections.length} sections)`);
    setTimeout(() => {
        const live = [...modal.querySelectorAll<HTMLButtonElement>("button")]
            .find(b => /go live/i.test(b.textContent ?? ""));
        if (live) {
            live.click();
            streamStep("pressed Go Live in Vesktop's picker");
        }
        else
            streamError("Vesktop's picker has no Go Live button, finish it there");
        for (const wait of [800, 2500])
            setTimeout(() => applyQuality(request), wait);
    }, 150);
    return true;
}

function watchPicker() {
    pickerWatch?.disconnect();
    pickerWatch = new MutationObserver(() => {
        if (answerPicker(document.body)) {
            pickerWatch?.disconnect();
            pickerWatch = undefined;
        }
    });
    pickerWatch.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
        pickerWatch?.disconnect();
        pickerWatch = undefined;
        pendingStream = null;
    }, 60000);
}

function shareScreenButton(): HTMLElement | null {
    const labels = new Set<string>(["Share Your Screen", "Share Screen", "Bildschirm teilen", "Deinen Bildschirm teilen"]);
    for (const key of ["SHARE_YOUR_SCREEN", "SHARE_SCREEN", "GO_LIVE_SHARE_SCREEN"]) {
        try {
            const text = getIntlMessage(key);
            if (typeof text === "string" && text)
                labels.add(text);
        } catch { /* key unknown */ }
    }
    const buttons = [...document.querySelectorAll<HTMLElement>("button[aria-label], [role=button][aria-label]")];
    return buttons.find(b => labels.has(b.getAttribute("aria-label") ?? "")) ?? null;
}

// venmic only hears the default output unless told otherwise
function hearAllOutputs() {
    try {
        const settings = vesktop()?.settings?.get?.();
        if (settings && settings.audio?.onlyDefaultSpeakers !== false)
            // set() replaces the whole store, so pass all of it plus the changed path
            vesktop().settings.set({ ...settings, audio: { ...(settings.audio ?? {}), onlyDefaultSpeakers: false } }, "audio");
    } catch (e) {
        console.warn("[ShellBridge] audio settings", e);
    }
}

async function startStream(request: StreamRequest) {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId)
        return streamError("Join a voice channel first");
    const channel = ChannelStore.getChannel(channelId);
    hearAllOutputs();

    try {
        const nodes = request.nodes ?? [];
        await vesktop()?.virtmic?.stop?.();
        if (request.audio === "system")
            await vesktop()?.virtmic?.startSystem(nodes);
        else if (request.audio === "apps" && nodes.length > 0)
            await vesktop()?.virtmic?.start(nodes);
        streamStep(`sound set up: ${request.audio}, ${nodes.length} app(s)`);
    } catch (e) {
        streamError(`Sound could not be set up: ${e}`);
    }

    pendingStream = { ...request, at: Date.now() };
    watchPicker();
    // Discord's stream action alone gives a black stream, so press the real button
    let button = shareScreenButton();
    if (!button) {
        streamStep("no share button here, opening the voice channel");
        NavigationRouter.transitionTo(`/channels/${channel?.guild_id ?? "@me"}/${channelId}`);
        for (let i = 0; i < 30 && !button; i++) {
            await new Promise(r => setTimeout(r, 100));
            button = shareScreenButton();
        }
    }
    if (!button) {
        pendingStream = null;
        pickerWatch?.disconnect();
        const seen = [...document.querySelectorAll<HTMLElement>("button[aria-label], [role=button][aria-label]")]
            .map(b => b.getAttribute("aria-label") ?? "")
            .filter(l => /screen|bildschirm|stream|live|übertrag/i.test(l));
        streamStep(`share buttons seen: ${JSON.stringify(seen)}`);
        return streamError("Discord's Share Your Screen button was not found");
    }
    streamStep(`pressing Discord's "${button.getAttribute("aria-label")}" button`);
    button.click();
}

function stopStream() {
    streamStep("stopping the stream");
    try {
        const stream = ApplicationStreamingStore?.getCurrentUserActiveStream?.();
        if (!stream)
            return;
        const { stop } = streamActions();
        if (!stop)
            return streamError("Discord's stream stop was not found");
        stop(streamKey(stream));
    } catch (e) {
        streamError(`Stopping the stream failed: ${e}`);
    }
}

// ── Launcher (d): contacts and direct messages ───────────────

// The DM you last wrote in, for "d reply"; unknown until you write one after Discord started
let lastDm: { userId: string; name: string; channelId: string } | null = null;

// The newest message in each DM, for the launcher list. Discord only caches messages of
// channels you opened, so DMs that arrive while the plugin runs are remembered here too.
type LastMessage = { author: string; content: string; mine: boolean; time: number };
const lastMessages = new Map<string, LastMessage>();

// A call posts an empty system message (type 3) into the DM; the launcher shows it as "(call)"
function messageText(message: any): string {
    return message?.content || (message?.attachments?.length ? "(attachment)" : message?.embeds?.length ? "(embed)" : message?.sticker_items?.length || message?.stickerItems?.length ? "(sticker)" : message?.type === 3 ? "(call)" : "");
}

// Message types someone actually wrote: default, reply, slash command and context menu command.
// The rest are system messages (call started, member added, channel renamed, pinned, ...).
const USER_MESSAGE_TYPES = new Set([0, 19, 20, 23]);

function isUserMessage(message: any): boolean {
    return USER_MESSAGE_TYPES.has(message?.type ?? 0);
}

function snowflakeTime(id: string | null | undefined): number {
    return id ? Number(BigInt(id) >> 22n) + 1420070400000 : 0;
}

function lastMessageOf(channel: any): LastMessage | null {
    const remembered = lastMessages.get(channel.id);
    if (remembered && remembered.time >= snowflakeTime(channel.lastMessageId))
        return remembered;
    const cached = MessageStore.getMessages?.(channel.id)?._array;
    const message = cached?.[cached.length - 1];
    if (message) {
        const me = UserStore.getCurrentUser()?.id;
        return { author: displayName(message.author), content: messageText(message), mine: message.author?.id === me, time: snowflakeTime(message.id) };
    }
    return remembered ?? null;
}

// What the launcher shows about a DM: when it moved last, the newest message, unread state
function activity(channel: any) {
    return {
        time: snowflakeTime(channel.lastMessageId),
        last: lastMessageOf(channel),
        unread: ReadStateStore.hasUnread?.(channel.id) ?? false,
        mentions: ReadStateStore.getMentionCount?.(channel.id) ?? 0
    };
}

function contactOf(userId: string, channel: any | null) {
    const user = UserStore.getUser(userId);
    return {
        userId, name: displayName(user), username: user?.username ?? "", avatar: avatarOf(user), channelId: channel?.id ?? null, group: false,
        ...(channel ? activity(channel) : { time: 0, last: null, unread: false, mentions: 0 })
    };
}

// A group DM in the contact list: no user, the channel is what gets opened or called
function groupContact(channel: any) {
    const members = (channel.recipients?.length ?? 0) + 1;
    return { userId: "", name: groupName(channel), username: `group · ${members} people`, avatar: groupIcon(channel), channelId: channel.id, group: true, ...activity(channel) };
}

function newestFirst(a: any, b: any) {
    const x = BigInt(a.lastMessageId ?? 0), y = BigInt(b.lastMessageId ?? 0);
    return x > y ? -1 : x < y ? 1 : 0;
}

// Open DMs and group DMs, most recent first, then friends without a DM yet
function contacts() {
    const channels = Object.values<any>(ChannelStore.getMutablePrivateChannels?.() ?? {})
        .filter(c => (c.type === 1 || c.type === 3) && c.recipients?.length)
        .sort(newestFirst);
    const out = channels.map(c => c.type === 3 ? groupContact(c) : contactOf(c.recipients[0], c));
    const seen = new Set(out.map(c => c.userId));
    for (const id of RelationshipStore.getFriendIDs?.() ?? [])
        if (!seen.has(id))
            out.push(contactOf(id, null));
    return out.slice(0, 300);
}

// Without a known last DM, "reply" goes to the most recent DM and says so
function replyTarget() {
    if (lastDm)
        return { ...lastDm, guessed: false };
    const first = contacts().find(c => c.channelId);
    return first ? { userId: first.userId, name: first.name, channelId: first.channelId as string, guessed: true } : null;
}

async function dmChannel(userId: string): Promise<string> {
    const existing = ChannelStore.getDMFromUserId?.(userId);
    if (existing)
        return existing;
    const { body } = await RestAPI.post({ url: "/users/@me/channels", body: { recipients: [userId] } });
    return body.id;
}

// To a user (userId) or straight into a channel such as a group DM (channelId)
async function sendDm(userId: string, content: string, channelId?: string) {
    const to = channelId && !userId ? groupName(ChannelStore.getChannel(channelId)) : displayName(UserStore.getUser(userId));
    try {
        channelId = channelId || await dmChannel(userId);
        await sendMessage(channelId, { content });
        Native.send({ type: "sent", ok: true, to });
    } catch (e) {
        Native.send({ type: "sent", ok: false, to, error: String(e) });
    }
}

// Into a channel the shell got a message from (the reply field on a notification): a DM,
// a group or a server channel. The shell shows "sent to …" from the answer.
async function sendToChannel(channelId: string, content: string) {
    const channel = ChannelStore.getChannel(channelId);
    const to = channel?.type === 1 ? displayName(UserStore.getUser(channel.recipients?.[0]))
        : channel?.type === 3 ? groupName(channel)
        : channel?.name ? `#${channel.name}` : "channel";
    try {
        if (!channel)
            throw new Error("channel not found");
        await sendMessage(channelId, { content });
        Native.send({ type: "sent", ok: true, to });
    } catch (e) {
        Native.send({ type: "sent", ok: false, to, error: String(e) });
    }
}

// Straight to the DM channel; a friend without one gets a real 1:1 DM first. Vencord's
// openPrivateChannel() hands Discord a bare user ID where it now wants { recipientIds },
// which opened an empty group with only you in it.
async function openDm(userId: string, channelId?: string) {
    try {
        channelId = channelId || await dmChannel(userId);
        focusWindow();
        NavigationRouter.transitionTo(`/channels/@me/${channelId}`);
    } catch (e) {
        console.warn("[ShellBridge] open dm failed", e);
    }
}

async function callUser(userId: string, channelId?: string) {
    try {
        channelId = channelId || await dmChannel(userId);
        focusWindow();
        ChannelActions.selectVoiceChannel(channelId);
        CallActions.ring(channelId);
    } catch (e) {
        console.warn("[ShellBridge] call failed", e);
    }
}

function run(command: any) {
    switch (command?.cmd) {
        case "list_contacts":
            Native.send({ type: "contacts", list: contacts(), lastDm: replyTarget() });
            break;
        case "open_dm":
            openDm(command.userId, command.channelId);
            break;
        case "call_user":
            callUser(command.userId, command.channelId);
            break;
        case "send_dm":
            sendDm(command.userId, String(command.content ?? ""), command.channelId);
            break;
        case "reply_last": {
            const target = replyTarget();
            if (target)
                sendDm(target.userId, String(command.content ?? ""));
            else
                Native.send({ type: "sent", ok: false, to: "", error: "no DM to reply to yet" });
            break;
        }
        case "send_message":
            sendToChannel(String(command.channelId ?? ""), String(command.content ?? ""));
            break;
        case "accept_call":
            focusWindow();
            ChannelActions.selectVoiceChannel(command.channelId);
            break;
        case "decline_call":
            declinedCalls.add(command.channelId);
            CallActions.stopRinging(command.channelId);
            break;
        case "call_back":
            // Join the DM call and ring the others; ring()'s arguments are a guess until tested
            ChannelActions.selectVoiceChannel(command.channelId);
            try {
                CallActions.ring(command.channelId);
            } catch (e) {
                console.warn("[ShellBridge] ring failed", e);
            }
            break;
        case "join_voice":
            ChannelActions.selectVoiceChannel(command.channelId);
            break;
        case "open_channel":
            focusWindow();
            NavigationRouter.transitionTo(`/channels/${command.guildId ?? "@me"}/${command.channelId}`);
            break;
        case "toggle_mute":
            AudioActions.toggleSelfMute();
            break;
        case "toggle_deafen":
            AudioActions.toggleSelfDeaf();
            break;
        // The shell (re)started and wants the overlay's state, your stream's viewers included
        case "voice_state":
            Native.send(voiceState());
            lastStream = "";
            sendStreamState();
            break;
        case "leave_voice":
            ChannelActions.selectVoiceChannel(null);
            break;
        case "audio_sources":
            sendAudioSources();
            break;
        case "start_stream":
            startStream(command as StreamRequest);
            break;
        case "stop_stream":
            stopStream();
            break;
        case "stream_quality":
            if (!applyQuality(command as StreamRequest))
                streamError("No running stream to change");
            break;
    }
}

export default definePlugin({
    name: "ShellBridge",
    description: "Sends Discord events to the Quickshell desktop shell and takes actions back",
    authors: [{ name: "vxnsin", id: 0n }],
    settings,

    contextMenus: {
        "channel-context": channelContextMenu
    },

    flux: {
        // DMs and messages that mention you
        MESSAGE_CREATE({ message, optimistic }: any) {
            if (optimistic)
                return;
            const me = UserStore.getCurrentUser();
            if (!me)
                return;
            const channel = ChannelStore.getChannel(message.channel_id);
            // Newest message per DM or group, for the launcher list
            if (channel?.type === 1 || channel?.type === 3)
                lastMessages.set(channel.id, {
                    author: message.author?.global_name ?? message.author?.username ?? "someone",
                    content: messageText(message),
                    mine: message.author?.id === me.id,
                    time: snowflakeTime(message.id)
                });
            // Your own DM: remember who it went to, for "d reply" in the launcher
            if (message.author?.id === me.id) {
                if (channel?.type === 1 && channel.recipients?.length) {
                    lastDm = { userId: channel.recipients[0], name: displayName(UserStore.getUser(channel.recipients[0])), channelId: channel.id };
                    Native.send({ type: "last_dm", ...lastDm, guessed: false });
                }
                return;
            }
            // A ringing call already notifies through CALL_CREATE; its system message would pop up a second time
            if (!isUserMessage(message))
                return;
            const isDm = channel?.isPrivate?.() ?? false;
            const mentioned = message.mention_everyone || (message.mentions ?? []).some((u: any) => u.id === me.id);
            if (!isDm && !mentioned)
                return;
            const content = messageText(message);
            if (!content)
                return;
            const guild = channel?.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
            // A group DM has no guild and often no name, so without kind it looked like a DM
            const kind = channel?.type === 3 ? "group" : channel?.guild_id ? "server" : "dm";
            Native.send({
                type: "message",
                kind,
                author: message.author.global_name ?? message.author.username,
                channel: kind === "group" ? groupName(channel) : channel?.name ?? "",
                guild: guild?.name ?? "",
                mentioned,
                content,
                avatar: message.author.avatar
                    ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png?size=128`
                    : "",
                channelId: message.channel_id,
                guildId: channel?.guild_id ?? null
            });
        },

        // Someone joins or leaves the voice channel you are in, or one you watch
        VOICE_STATE_UPDATES({ voiceStates }: any) {
            const me = UserStore.getCurrentUser()?.id;
            const mine = SelectedChannelStore.getVoiceChannelId();
            // The overlay: anything in your channel (or you moving) changes its list
            if (voiceStates.some((s: any) => s.userId === me || (mine && (s.channelId === mine || s.oldChannelId === mine))))
                sendVoiceState();
            const relevant = [mine, ...watchedChannels()].filter((id, i, all) => id && all.indexOf(id) === i) as string[];
            if (relevant.length === 0)
                return;
            for (const { userId, channelId, oldChannelId } of voiceStates) {
                if (userId === me)
                    continue;
                for (const watchedId of relevant) {
                    const joined = channelId === watchedId && oldChannelId !== watchedId;
                    const left = oldChannelId === watchedId && channelId !== watchedId;
                    if (!joined && !left)
                        continue;
                    const user = UserStore.getUser(userId);
                    Native.send({
                        type: "voice",
                        action: joined ? "join" : "leave",
                        user: displayName(user),
                        channel: channelName(watchedId),
                        count: membersIn(watchedId),
                        avatar: avatarOf(user),
                        channelId: watchedId,
                        // Only watched channels you are not in get a join button
                        watched: watchedId !== mine
                    });
                }
            }
        },

        // A scheduled server event goes live (status 2 = active)
        GUILD_SCHEDULED_EVENT_UPDATE({ guildScheduledEvent: event }: any) {
            if (!event || event.status !== 2 || startedEvents.has(event.id))
                return;
            startedEvents.add(event.id);
            const guild = GuildStore.getGuild(event.guild_id);
            Native.send({
                type: "event",
                name: event.name,
                guild: guild?.name ?? "",
                // Stage (1) and voice (2) events have a channel to join, external (3) a location
                channel: event.channel_id ? channelName(event.channel_id) : "",
                location: event.entity_metadata?.location ?? "",
                channelId: event.channel_id ?? null,
                guildId: event.guild_id
            });
        },

        CALL_CREATE({ channelId, ringing, ongoingRings }: any) {
            handleCall(channelId, ringingUsers(ringing, ongoingRings));
        },

        CALL_UPDATE({ channelId, ringing, ongoingRings }: any) {
            handleCall(channelId, ringingUsers(ringing, ongoingRings));
        },

        // The caller hung up before anyone answered
        CALL_DELETE({ channelId }: any) {
            endCall(channelId);
        },

        // The store updates right after the event, so read it a moment later
        AUDIO_TOGGLE_SELF_MUTE() {
            setTimeout(sendSelfState, 50);
            sendVoiceState();
        },

        AUDIO_TOGGLE_SELF_DEAF() {
            setTimeout(sendSelfState, 50);
            sendVoiceState();
        },

        // You joined, left or switched a voice channel (leaving also ends your stream)
        VOICE_CHANNEL_SELECT() {
            speaking.clear();
            sendVoiceState();
            sendStreamState();
        },

        // A microphone opens or closes (speakingFlags 0: quiet); only the change is sent,
        // the overlay keeps the list
        SPEAKING({ userId, speakingFlags }: any) {
            const now = !!speakingFlags;
            if (now === speaking.has(userId))
                return;
            if (now)
                speaking.add(userId);
            else
                speaking.delete(userId);
            Native.send({ type: "speaking", userId, speaking: now });
        }
    },

    start() {
        Native.connect();
        window.addEventListener("keydown", typeAltGr, true);
        // Your stream starting, ending and its viewers coming and going all change this store
        try {
            ApplicationStreamingStore.addChangeListener(sendStreamState);
        } catch (e) {
            console.warn("[ShellBridge] no ApplicationStreamingStore, stream viewers stay off", e);
        }
        // The native side cannot call into the renderer, so pick up commands here
        commandPoll = setInterval(async () => {
            for (const command of await Native.takeCommands())
                run(command);
        }, 300);
    },

    stop() {
        clearInterval(commandPoll);
        window.removeEventListener("keydown", typeAltGr, true);
        ringingCalls.clear();
        declinedCalls.clear();
        speaking.clear();
        clearTimeout(voiceTimer);
        clearTimeout(streamTimer);
        pickerWatch?.disconnect();
        pendingStream = null;
        lastStream = "";
        try {
            ApplicationStreamingStore.removeChangeListener(sendStreamState);
        } catch {
            // Never attached
        }
        Native.disconnect();
    }
});
