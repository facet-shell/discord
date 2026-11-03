/*
 * ShellBridge – Vencord user plugin for frameshell
 *
 * Sends Discord events to the Quickshell shell over a Unix socket and runs the actions
 * the shell sends back. Protocol: see quickshell/.config/quickshell/services/DiscordBridge.qml.
 *
 * Events: DMs and mentions, people joining/leaving your voice channel (and channels you
 * watch, see "Watch in shell" in a voice channel's right-click menu), scheduled server
 * events going live, incoming calls and how they ended (answered, declined, missed), your own mute/deafen changes.
 * Actions: accept/decline call, call back, join a watched channel, open channel, toggle mute/deafen,
 * and for the launcher (d): list contacts, open a DM, call someone, send a DM, reply to the
 * last person you wrote to.
 *
 * Discord's internal module and event names change now and then; if something stops
 * working, check them first.
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, GuildStore, Menu, MessageStore, NavigationRouter, React, ReadStateStore, RelationshipStore, RestAPI, SelectedChannelStore, UserStore } from "@webpack/common";

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
        },

        AUDIO_TOGGLE_SELF_DEAF() {
            setTimeout(sendSelfState, 50);
        }
    },

    start() {
        Native.connect();
        window.addEventListener("keydown", typeAltGr, true);
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
        Native.disconnect();
    }
});
