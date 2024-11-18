import express from "express";
import { getRequiredEnvVar, setDefaultEnvVar } from "./envHelpers";
import {
  addAlchemyContextToRequest,
  validateAlchemySignature,
  AlchemyWebhookEvent,
} from "./webhooksUtil";
import TelegramBot from "node-telegram-bot-api";
import { Alchemy, Network } from "alchemy-sdk";
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
  const alchemyAuthToken = getRequiredEnvVar("ALCHEMY_AUTH_TOKEN");
  const alchemyWebhookId = getRequiredEnvVar("ALCHEMY_WEBHOOK_ID");

  // Initialize Telegram Bot
  const bot = new TelegramBot(telegramToken, { polling: true });

  // Initialize Alchemy SDK
  const alchemySettings = {
    authToken: alchemyAuthToken,
    network: Network.ETH_MAINNET, // Update to your desired network
  };
  const alchemy = new Alchemy(alchemySettings);

  // Telegram commands to add and remove addresses
  bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const address = match ? match[1] : null;

    if (!address) {
      bot.sendMessage(chatId, "Please provide a valid Ethereum address.");
      return;
    }

    try {
      // Check if address already exists
      const existingAddresses = await alchemy.notify.getAddresses(
        alchemyWebhookId
      );
      if (existingAddresses.addresses.includes(address)) {
        bot.sendMessage(chatId, `Address ${address} is already being tracked.`);
        return;
      }

      // Add the address to the webhook
      await alchemy.notify.updateWebhook(alchemyWebhookId, {
        addAddresses: [address],
      });

      bot.sendMessage(
        chatId,
        `Address ${address} has been successfully added for tracking.`
      );
    } catch (error: any) {
      console.error("Error adding address:", error);
      bot.sendMessage(
        chatId,
        `Failed to add address ${address}: ${error.message}`
      );
    }
  });

  bot.onText(/\/rm (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const address = match ? match[1] : null;

    if (!address) {
      bot.sendMessage(chatId, "Please provide a valid Ethereum address.");
      return;
    }

    try {
      // Remove the address from the webhook
      await alchemy.notify.updateWebhook(alchemyWebhookId, {
        removeAddresses: [address],
      });

      bot.sendMessage(
        chatId,
        `Address ${address} has been successfully removed from tracking.`
      );
    } catch (error: any) {
      console.error("Error removing address:", error);
      bot.sendMessage(
        chatId,
        `Failed to remove address ${address}: ${error.message}`
      );
    }
  });

  // Add this after your other bot.onText commands
  bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;

    try {
      const addresses = await alchemy.notify.getAddresses(alchemyWebhookId);

      if (!addresses.addresses.length) {
        bot.sendMessage(chatId, "No addresses are currently being tracked.");
        return;
      }

      const addressList = addresses.addresses.join("\n");
      bot.sendMessage(chatId, `Currently tracked addresses:\n${addressList}`);
    } catch (error: any) {
      console.error("Error listing addresses:", error);
      bot.sendMessage(chatId, `Failed to list addresses: ${error.message}`);
    }
  });

  // Middleware needed to validate the Alchemy signature
  app.use(
    express.json({
      verify: addAlchemyContextToRequest,
    })
  );
  app.use(validateAlchemySignature(signingKey));

  app.post("/webhook-path", async (req, res) => {
    const hotwallets = ["0xd2507b4958b449695201599e8d8a25f4bab5dead"];
    const webhookEvent = req.body as AlchemyWebhookEvent;
    console.log("Received webhook event:", webhookEvent);

    try {
      // Vérifier que event et activity existent
      if (
        !webhookEvent.event ||
        !webhookEvent.event.activity ||
        !Array.isArray(webhookEvent.event.activity)
      ) {
        throw new Error(
          "Invalid webhook payload: 'event.activity' is missing or invalid."
        );
      }

      for (const activity of webhookEvent.event.activity) {
        // Vérifier que chaque champ clé est défini
        const { asset, fromAddress, toAddress, value, hash, blockNum } =
          activity;

        if (!asset || !fromAddress || !toAddress || !hash || !blockNum) {
          console.warn("Invalid activity data:", activity);
          continue; // Ignore cette activité et passe à la suivante
        }

        // Skip ETH transactions
        if (asset === "ETH" || asset === "WETH" || asset === "USDC") {
          continue;
        }

        const isHotWallet =
          hotwallets.includes(fromAddress) || hotwallets.includes(toAddress);
        const hotWalletPrefix = isHotWallet ? "🔥 HOT WALLET ALERT 🔥\n" : "";

        const message = `
${hotWalletPrefix}🚀 *New Wallet Event* 🚀
\\- Network: \`${webhookEvent.event.network || "Unknown"}\`
\\- Asset: \`${asset}\`
\\- From: \`${fromAddress}\` [(view)](https://dexscreener.com/base/${fromAddress})
\\- To: \`${toAddress}\` [(view)](https://dexscreener.com/base/${toAddress})
\\- [View Transaction](https://basescan.org/tx/${hash})
      `;

        // Envoyer le message à Telegram
        try {
          await bot.sendMessage(telegramChatId, message, {
            parse_mode: "Markdown",
          });
          console.log(
            "Notification sent to Telegram successfully for activity:",
            hash
          );
        } catch (error) {
          console.error(
            "Error sending Telegram message for activity:",
            hash,
            error
          );
        }
      }

      res.status(200).send("Webhook processed successfully.");
    } catch (error) {
      console.error("Error processing webhook:", error);
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
