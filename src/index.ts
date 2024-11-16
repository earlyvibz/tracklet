import express from "express";
import { getRequiredEnvVar, setDefaultEnvVar } from "./envHelpers";
import {
  addAlchemyContextToRequest,
  validateAlchemySignature,
  AlchemyWebhookEvent,
} from "./webhooksUtil";
import TelegramBot from "node-telegram-bot-api";
import * as dotenv from "dotenv";

dotenv.config();

async function main(): Promise<void> {
  const app = express();

  // Set default environment variables
  setDefaultEnvVar("PORT", "8080");
  setDefaultEnvVar("HOST", "127.0.0.1");
  setDefaultEnvVar("SIGNING_KEY", "whsec_test");

  // Load required environment variables
  const port = +getRequiredEnvVar("PORT");
  const host = getRequiredEnvVar("HOST");
  const signingKey = getRequiredEnvVar("SIGNING_KEY");
  const telegramToken = getRequiredEnvVar("TELEGRAM_BOT_TOKEN");
  const telegramChatId = getRequiredEnvVar("TELEGRAM_CHAT_ID");

  // Initialize Telegram Bot
  const bot = new TelegramBot(telegramToken, { polling: false });

  // Middleware needed to validate the Alchemy signature
  app.use(
    express.json({
      verify: addAlchemyContextToRequest,
    })
  );
  app.use(validateAlchemySignature(signingKey));

  // Register handler for Alchemy Notify webhook events
  app.post("/webhook-path", async (req, res) => {
    const webhookEvent = req.body as AlchemyWebhookEvent;

    try {
      if (webhookEvent.event.activity) {
        const message = `
    🚀 *New Wallet Event* 🚀
    - Network: ${webhookEvent.event.activity.network}
    - Address: ${webhookEvent.event.activity.fromAddress}
    - To: ${webhookEvent.event.activity.toAddress}
    - Date: ${webhookEvent.event.createdAt}
        `;

        // Send the message to Telegram
        await bot.sendMessage(telegramChatId, message, {
          parse_mode: "Markdown",
        });

        console.log("Notification sent to Telegram successfully.");
      }

      res.status(200).send("Alchemy Notify is the best!");
    } catch (error) {
      console.error(
        "Error processing webhook or sending Telegram message:",
        error
      );
      res.status(500).send("Failed to process the webhook.");
    }
  });

  // Start the server
  app.listen(port, host, () => {
    console.log(
      `Example Alchemy Notify app listening at http://${host}:${port}`
    );
  });
}

main().catch((err) => {
  console.error("Failed to start the server:", err);
});
