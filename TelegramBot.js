import { Telegraf } from "telegraf";
import rateLimit from "telegraf-ratelimit";
import * as dotEnv from "dotenv";
import { Filter } from "bad-words";
import express from "express";
import fs from "fs/promises";
import path from "path";

console.log = function () {};

dotEnv.config({ path: "./config.env" });

const bot = new Telegraf(process.env.Token);

const app = express();
const port = process.env.PORT || 3000;

//for profanity
const filter = new Filter();

const activeUsers = new Set();
const pairedPartners = new Map();
const chatHistory = new Map();
const bannedUsers = new Map();

const DATA_FILE = path.resolve("./bot-data.json");
async function saveData() {
  try {
    const data = {
      activeUsers: Array.from(activeUsers),
      pairedPartners: Array.from(pairedPartners.entries()),
      chatHistory: Array.from(chatHistory.entries()),
      bannedUsers: Array.from(bannedUsers.entries()),
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
    console.log("Data saved to", DATA_FILE);
  } catch (err) {
    console.error("Error saving data");
  }
}

async function loadData() {
  try {
    const content = await fs.readFile(DATA_FILE, "utf-8");
    const data = JSON.parse(content);

    data.activeUsers.forEach((id) => activeUsers.add(id));
    data.pairedPartners.forEach(([key, value]) =>
      pairedPartners.set(key, value),
    );
    data.chatHistory.forEach(([key, value]) => chatHistory.set(key, value));
    data.bannedUsers.forEach(([key, value]) => bannedUsers.set(key, value));
  } catch (err) {
    if (err.code === "ENOENT") {
      console.log("No data file found, starting fresh.");
    } else {
      console.error("Error loading data:", err);
    }
  }
}

function safeInterval(fn, intervalMs) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      console.error("Error in interval:", err);
    }
    running = false;
  }, intervalMs);
}
await loadData();

safeInterval(
  () => {
    chatHistory.clear();
    saveData();
  },
  1 * 60 * 60 * 1000,
);

safeInterval(saveData, 30 * 1000);

const limitConfig = {
  window: Number(process.env.WindowSize) || 3000,
  limit: Number(process.env.LimitSize) || 3,
  onLimitExceeded: (ctx) => ctx.reply("Rate limit exceeded!"),
};
bot.use(rateLimit(limitConfig));

safeInterval(
  () => {
    const now = Date.now();
    for (const [userId, expiry] of bannedUsers.entries()) {
      if (expiry < now) {
        bannedUsers.delete(userId);
        bot.telegram.sendMessage(
          userId,
          "You are now unbanned! Enjoy chatting.",
        );
      }
    }
  },
  5 * 60 * 1000,
);

function disconnectUsers(userId, partnerId, ctx) {
  pairedPartners.delete(userId);
  pairedPartners.delete(partnerId);
  try {
    ctx.telegram.sendMessage(userId, `You left the chat 🗨️`, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🚫 Report Partner",
              callback_data: `report_${partnerId}}`,
            },
          ],
          [{ text: "Find Partner🔍", callback_data: "find_partner" }],
        ],
      },
    });

    ctx.telegram.sendMessage(partnerId, `Your partner left the chat 🗨️`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🚫 Report Partner", callback_data: `report_${userId}` }],
          [{ text: "Find Partner🔍", callback_data: "find_partner" }],
        ],
      },
    });
  } catch (Error) {
    //console.log(Error)
  }
}

bot.start((ctx) => {
  ctx.reply(`Welcome to AnonnyChatBot😁! A better place to find a best friend!

/search - 🔍  Search for a partner 
/list - to list all commands in the bot
`);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleSearch(ctx) {
  const userId = ctx.chat.id;

  if (bannedUsers.has(userId)) {
    const unbanTime = new Date(bannedUsers.get(userId)).toUTCString();
    ctx.reply(`⛔ You are banned for 24 hours. Try again at ${unbanTime}`);
    return;
  }
  try {
    ctx.reply("🔍 Searching for a partner...", {
      reply_markup: {
        keyboard: [[{ text: "Stop Searching🚫" }]],
        resize_keyboard: true,
      },
    });

    await delay(1500);

    for (const candidate of activeUsers) {
      if (candidate !== userId) {
        activeUsers.delete(candidate);
        pairedPartners.set(userId, candidate);
        pairedPartners.set(candidate, userId);

        ctx.telegram.sendMessage(userId, "✅ You are now connected!", {
          reply_markup: { remove_keyboard: true },
        });
        ctx.telegram.sendMessage(candidate, "✅ You are now connected!", {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
    }

    activeUsers.add(userId);
  } catch (error) {
    console.log(error);
  }
}

bot.command("search", handleSearch);

bot.hears("Stop Searching🚫", (ctx) => {
  const userId = ctx.chat.id;
  if (activeUsers.has(userId)) {
    activeUsers.delete(userId);
    ctx.reply("❌ Stopped searching. Use /search to try again.", {
      reply_markup: {
        remove_keyboard: true,
      },
      parse_mode: "Markdown",
    });
  } else {
    ctx.reply("⚠️ You weren't searching.");
  }
});

bot.hears("Find new Partner🔍", handleSearch);

bot.command("list", (ctx) => {
  ctx.telegram.sendMessage(
    ctx.chat.id,
    `/start -▶ Start the bot
/search - 🔍  Search for a partner 
/stop -🛑 Stop current  conversation
/link - 🔗  Share your profile to partner
`,
  );
});

bot.command("link", (ctx) => {
  try {
    const userId = ctx.chat.id;
    const partnerId = pairedPartners.get(userId);
    if (!partnerId) {
      return ctx.reply("⚠️ You're not currently in a chat.");
    }

    if (!ctx.chat.username) {
      return ctx.reply("⚠️ You don’t have a Telegram username set.");
    }
    ctx.telegram.sendMessage(
      userId,
      "Your profile id was sent to the partner😊",
    );
    ctx.telegram.sendMessage(partnerId, `🔗 @${ctx.chat.username}`);
  } catch (error) {
    //console.log(error)
  }
});

bot.command("stop", (ctx) => {
  const userId = ctx.chat.id;
  const partnerId = pairedPartners.get(userId);

  if (partnerId) {
    disconnectUsers(userId, partnerId, ctx);
  } else {
    ctx.reply("⚠️ You're not currently in a chat.");
  }
});

bot.action("find_partner", handleSearch);

bot.action(/report_(\d+)/, async (ctx) => {
  const reporterId = ctx.chat.id;
  const partnerId = Number(ctx.match[1]);

  if (reporterId === partnerId) return;

  ctx.reply("✅ Thanks for reporting!We are reviewing the chat history...");

  const messages = chatHistory.get(partnerId) || [];

  let badWordCount = 0;
  let mediaCount = 0;

  for (const message of messages) {
    if (typeof message === "string" && filter.isProfane(message)) {
      badWordCount++;
    } else if (typeof message === "object") {
      mediaCount++;
    }
  }

  const BAD_WORD_LIMIT = Number(process.env.BAD_WORD_LIMIT) || 5;
  const SPAM_LIMIT = Number(process.env.SPAM_LIMIT) || 20;

  if (badWordCount > BAD_WORD_LIMIT || mediaCount > SPAM_LIMIT) {
    bannedUsers.set(partnerId, Date.now() + 24 * 60 * 60 * 1000);
    try {
      await ctx.telegram.sendMessage(
        partnerId,
        "🚫 You’ve been banned for 24h due to inappropriate behavior.",
      );
    } catch (e) {
      console.error("Failed to notify banned user:", e.message);
    }
  }
});

bot.on("message", (ctx) => {
  const userId = ctx.chat.id;
  const partnerId = pairedPartners.get(userId);

  if (!partnerId) {
    return ctx.reply("⚠️ You're not in a chat. Use /search to find a partner.");
  }

  try {
    ctx.telegram.copyMessage(partnerId, userId, ctx.message.message_id);
  } catch (e) {
    console.error("Failed to forward message:", e.message);
  }

  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  if (!chatHistory.has(partnerId)) chatHistory.set(partnerId, []);

  let entry;
  if (ctx.message.text) {
    entry = ctx.message.text;
  } else if (ctx.message.photo) {
    entry = { type: "photo" };
  } else if (ctx.message.sticker) {
    entry = { type: "sticker" };
  } else {
    entry = { type: "unknown" };
  }
  chatHistory.get(userId).push(entry);
});

bot.launch();
app.listen(port, () => {
  console.log(`Bot is running on port ${port}`);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
