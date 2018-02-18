const Eris = require('eris');
const moment = require('moment');

const config = require('./config');
const bot = require('./bot');
const Queue = require('./queue');
const utils = require('./utils');
const threadUtils = require('./threadUtils');
const blocked = require('./data/blocked');
const threads = require('./data/threads');

const snippets = require('./plugins/snippets');
const webserver = require('./plugins/webserver');
const greeting = require('./plugins/greeting');
const attachments = require("./data/attachments");

const messageQueue = new Queue();

const addInboxServerCommand = (...args) => threadUtils.addInboxServerCommand(bot, ...args);

// Once the bot has connected, set the status/"playing" message
bot.on('ready', () => {
  bot.editStatus(null, {name: config.status});
});

/**
 * When a moderator posts in a modmail thread...
 * 1) If alwaysReply is enabled, reply to the user
 * 2) If alwaysReply is disabled, save that message as a chat message in the thread
 */
bot.on('messageCreate', async msg => {
  if (! utils.messageIsOnInboxServer(msg)) return;
  if (! utils.isStaff(msg.member)) return;
  if (msg.author.bot) return;
  if (msg.content.startsWith(config.prefix) || msg.content.startsWith(config.snippetPrefix)) return;

  const thread = await threads.findByChannelId(msg.channel.id);
  if (! thread) return;

  if (config.alwaysReply) {
    // AUTO-REPLY: If config.alwaysReply is enabled, send all chat messages in thread channels as replies
    if (msg.attachments.length) await attachments.saveAttachmentsInMessage(msg);
    await thread.replyToUser(msg.member, msg.content.trim(), msg.attachments, config.alwaysReplyAnon || false);
    msg.delete();
  } else {
    // Otherwise just save the messages as "chat" in the logs
    thread.saveChatMessage(msg);
  }
});

/**
 * When we get a private message...
 * 1) Find the open modmail thread for this user, or create a new one
 * 2) Post the message as a user reply in the thread
 */
bot.on('messageCreate', async msg => {
  if (! (msg.channel instanceof Eris.PrivateChannel)) return;
  if (msg.author.bot) return;
  if (msg.type !== 0) return; // Ignore pins etc.

  if (await blocked.isBlocked(msg.author.id)) return;

  // Private message handling is queued so e.g. multiple message in quick succession don't result in multiple channels being created
  messageQueue.add(async () => {
    const thread = await threads.findOrCreateThreadForUser(msg.author);
    await thread.receiveUserReply(msg);
  });
});

/**
 * When a message is edited...
 * 1) If that message was in DMs, and we have a thread open with that user, post the edit as a system message in the thread
 * 2) If that message was moderator chatter in the thread, update the corresponding chat message in the DB
 */
bot.on('messageUpdate', async (msg, oldMessage) => {
  if (msg.author.bot) return;
  if (await blocked.isBlocked(msg.author.id)) return;

  let oldContent = oldMessage.content;
  const newContent = msg.content;

  // Old message content doesn't persist between bot restarts
  if (oldContent == null) oldContent = '*Unavailable due to bot restart*';

  // Ignore bogus edit events with no changes
  if (newContent.trim() === oldContent.trim()) return;

  // 1) Edit in DMs
  if (msg.channel instanceof Eris.PrivateChannel) {
    const thread = await threads.findOpenThreadByUserId(msg.author.id);
    const editMessage = utils.disableLinkPreviews(`**The user edited their message:**\n\`B:\` ${oldContent}\n\`A:\` ${newContent}`);

    thread.postSystemMessage(editMessage);
  }

  // 2) Edit in the thread
  else if (utils.messageIsOnInboxServer(msg) && utils.isStaff(msg.member)) {
    const thread = await threads.findOpenThreadByChannelId(msg.channel.id);
    if (! thread) return;

    thread.updateChatMessage(msg);
  }
});

/**
 * When a staff message is deleted in a modmail thread, delete it from the database as well
 */
bot.on('messageDelete', async msg => {
  if (msg.author.bot) return;
  if (! utils.messageIsOnInboxServer(msg)) return;
  if (! utils.isStaff(msg.member)) return;

  const thread = await threads.findOpenThreadByChannelId(msg.channel.id);
  if (! thread) return;

  thread.deleteChatMessage(msg.id);
});

/**
 * When the bot is mentioned on the main server, ping staff in the log channel about it
 */
bot.on('messageCreate', async msg => {
  if (! utils.messageIsOnMainServer(msg)) return;
  if (! msg.mentions.some(user => user.id === bot.user.id)) return;

  // If the person who mentioned the modmail bot is also on the modmail server, ignore them
  if (utils.getInboxGuild().members.get(msg.author.id)) return;

  // If the person who mentioned the bot is blocked, ignore them
  if (await blocked.isBlocked(msg.author.id)) return;

  bot.createMessage(utils.getLogChannel(bot).id, {
    content: `@here Bot mentioned in ${msg.channel.mention} by **${msg.author.username}#${msg.author.discriminator}**: "${msg.cleanContent}"`,
    disableEveryone: false,
  });
});

// Mods can reply to modmail threads using !r or !reply
// These messages get relayed back to the DM thread between the bot and the user
addInboxServerCommand('reply', async (msg, args, thread) => {
  if (! thread) return;

  const text = args.join(' ').trim();
  if (msg.attachments.length) await attachments.saveAttachmentsInMessage(msg);
  await thread.replyToUser(msg.member, text, msg.attachments, false);
  msg.delete();
});

bot.registerCommandAlias('r', 'reply');

// Anonymous replies only show the role, not the username
addInboxServerCommand('anonreply', async (msg, args, thread) => {
  if (! thread) return;

  const text = args.join(' ').trim();
  if (msg.attachments.length) await attachments.saveAttachmentsInMessage(msg);
  await thread.replyToUser(msg.member, text, msg.attachments, true);
  msg.delete();
});

bot.registerCommandAlias('ar', 'anonreply');

// Close a thread. Closing a thread saves a log of the channel's contents and then deletes the channel.
addInboxServerCommand('close', async (msg, args, thread) => {
  if (! thread) return;
  thread.close();
});

addInboxServerCommand('block', (msg, args, thread) => {
  async function block(userId) {
    await blocked.block(userId);
    msg.channel.createMessage(`Blocked <@${userId}> (id ${userId}) from modmail`);
  }

  if (args.length > 0) {
    // User mention/id as argument
    const userId = utils.getUserMention(args.join(' '));
    if (! userId) return;
    block(userId);
  } else if (thread) {
    // Calling !block without args in a modmail thread blocks the user of that thread
    block(thread.user_id);
  }
});

addInboxServerCommand('unblock', (msg, args, thread) => {
  async function unblock(userId) {
    await blocked.unblock(userId);
    msg.channel.createMessage(`Unblocked <@${userId}> (id ${userId}) from modmail`);
  }

  if (args.length > 0) {
    // User mention/id as argument
    const userId = utils.getUserMention(args.join(' '));
    if (! userId) return;
    unblock(userId);
  } else if (thread) {
    // Calling !unblock without args in a modmail thread unblocks the user of that thread
    unblock(thread.user_id);
  }
});

addInboxServerCommand('logs', (msg, args, thread) => {
  async function getLogs(userId) {
    const userThreads = await threads.getClosedThreadsByUserId(userId);
    userThreads.reverse();

    const threadLines = await Promise.all(userThreads.map(async thread => {
      const logUrl = await thread.getLogUrl();
      const formattedDate = moment.utc(thread.created_at).format('MMM Do [at] HH:mm [UTC]');
      return `\`${formattedDate}\`: <${logUrl}>`;
    }));

    const message = `**Log files for <@${userId}>:**\n${threadLines.join('\n')}`;

    // Send the list of logs in chunks of 15 lines per message
    const lines = message.split('\n');
    const chunks = utils.chunk(lines, 15);

    let root = Promise.resolve();
    chunks.forEach(lines => {
      root = root.then(() => msg.channel.createMessage(lines.join('\n')));
    });
  }

  if (args.length > 0) {
    // User mention/id as argument
    const userId = utils.getUserMention(args.join(' '));
    if (! userId) return;
    getLogs(userId);
  } else if (thread) {
    // Calling !logs without args in a modmail thread returns the logs of the user of that thread
    getLogs(thread.user_id);
  }
});

module.exports = {
  async start() {
    // Load plugins
    console.log('Loading plugins...');
    await snippets(bot);
    await greeting(bot);
    await webserver(bot);

    console.log('Connecting to Discord...');
    await bot.connect();

    console.log('Done! Now listening to DMs.');
  }
};
