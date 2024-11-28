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

  setDefaultEnvVar("PORT", "8080");
  setDefaultEnvVar("HOST", "127.0.0.1");
  setDefaultEnvVar("SIGNING_KEY", "whsec_test");

  const port = +getRequiredEnvVar("PORT");
  const host = getRequiredEnvVar("HOST");
  const signingKey = getRequiredEnvVar("SIGNING_KEY");
  const telegramToken = getRequiredEnvVar("TELEGRAM_BOT_TOKEN");
  const telegramChatId = getRequiredEnvVar("TELEGRAM_CHAT_ID");
  const alchemyAuthToken = getRequiredEnvVar("ALCHEMY_AUTH_TOKEN");
  const alchemyWebhookId = getRequiredEnvVar("ALCHEMY_WEBHOOK_ID");

  const bot = new TelegramBot(telegramToken, { polling: true });

  const alchemySettings = {
    authToken: alchemyAuthToken,
    network: Network.ETH_MAINNET,
  };
  const alchemy = new Alchemy(alchemySettings);

  bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const address = match ? match[1] : null;

    if (!address) {
      bot.sendMessage(chatId, "Please provide a valid Ethereum address.");
      return;
    }

    try {
      const existingAddresses = await alchemy.notify.getAddresses(
        alchemyWebhookId
      );
      if (existingAddresses.addresses.includes(address)) {
        bot.sendMessage(chatId, `Address ${address} is already being tracked.`);
        return;
      }

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

  app.use(
    express.json({
      verify: addAlchemyContextToRequest,
    })
  );
  app.use(validateAlchemySignature(signingKey));

  const WALLETS = {
    hot: new Set([
      "0xd2507b4958b449695201599e8d8a25f4bab5dead",
      "0x6fb5489c6d6c11150e68d6d87dca963beb28d5b0",
      "0xc51e5421608efc404b76fcf4da7d44cdd8481903",
      "0x8bb8fa6ce99208c1cddea7006679145a490ee58f",
    ]),
    whales: new Set(["0x6552d32C1a0563d6bD434C761771341058862f78"]),
    multipliers: new Set([""]),
    suspicious: new Set(["0x00081fbbd7175d902b459dc85f7da70cbd000000"]),
  };

  const IGNORED_ASSETS = new Set([
    "ETH",
    "WEТH",
    "UЅDС",
    "VIRTUAL",
    "WALLY",
    "Rizzmas",
  ]);

  app.post("/webhook-path", async (req, res) => {
    res.status(200).send("Success");

    const webhookEvent = req.body as AlchemyWebhookEvent;

    if (!webhookEvent?.event?.activity?.length) {
      console.error("Invalid webhook payload");
      return;
    }

    const formatMarketCap = (value: number) => {
      if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
      if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
      if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}k`;
      return `$${value}`;
    };

    await Promise.all(
      webhookEvent.event.activity.map(async (activity: any) => {
        const {
          asset,
          hash,
          blockNum,
          erc721TokenId,
          erc1155Metadata,
          rawContract,
          value,
          log,
        } = activity;

        const fromAddress = `0x${log.topics[1].slice(26)}`;
        const toAddress = `0x${log.topics[2].slice(26)}`;

        if (!asset || !fromAddress || !toAddress || !hash || !blockNum) return;
        if (IGNORED_ASSETS.has(asset)) return;
        if (erc721TokenId || erc1155Metadata) return;

        let marketCap = "N/A";
        let dexPairAddress = "";
        try {
          const dexScreenerResponse = await fetch(
            `https://api.dexscreener.com/latest/dex/tokens/${rawContract.address}`,
            {
              headers: {
                Accept: "application/json",
                "User-Agent": "Mozilla/5.0",
              },
            }
          );
          const dexScreenerData = await dexScreenerResponse.json();

          if (!dexScreenerData?.pairs?.[0]) return;

          marketCap = dexScreenerData.pairs[0].marketCap
            ? formatMarketCap(dexScreenerData.pairs[0].marketCap)
            : "N/A";

          dexPairAddress =
            dexScreenerData.pairs[0].pairAddress?.toLowerCase() || "";
        } catch (error) {
          console.error(
            `Failed to fetch marketcap for ${rawContract.address}:`,
            error
          );
        }

        const prefixes = [];
        if (WALLETS.hot.has(fromAddress) || WALLETS.hot.has(toAddress))
          prefixes.push("🔥 HOT WALLET ALERT 🔥");
        if (WALLETS.whales.has(fromAddress) || WALLETS.whales.has(toAddress))
          prefixes.push("🐳 WHALE ALERT 🐳");
        if (
          WALLETS.multipliers.has(fromAddress) ||
          WALLETS.multipliers.has(toAddress)
        )
          prefixes.push("💰 BIG MULTIPLIER ALERT 💰");
        if (
          WALLETS.suspicious.has(fromAddress) ||
          WALLETS.suspicious.has(toAddress)
        )
          prefixes.push("🚨 SUSPICIOUS WALLET ALERT 🚨");

        const userWallet =
          fromAddress.toLowerCase() === dexPairAddress
            ? toAddress
            : fromAddress;
        const tradeType =
          fromAddress.toLowerCase() === dexPairAddress
            ? "🟢 BOUGHT"
            : "🔴 SOLD";

        const message = `
${prefixes.join("\n")}
\\- 💎 Asset: \`${asset}\` [dexscreener](https://dexscreener.com/base/${
          rawContract.address
        }?maker=${userWallet})
\\- 💰 Contract: \`${rawContract.address}\`
\\- 💰 MC: \`${marketCap}\`
\\- 👤 User (\`${tradeType}\`): \`${userWallet}\`
\\- 💵 Value: \`${value}\`
\\- 🔍 [View Transaction](https://basescan.org/tx/${hash})`;

        try {
          await bot.sendMessage(telegramChatId, message, {
            parse_mode: "Markdown",
          });
        } catch (error) {
          console.error("Telegram error:", hash, error);
        }
      })
    );
  });

  app.listen(port, host, () => {
    console.log(
      `Example Alchemy Notify app listening at http://${host}:${port}`
    );
  });
}

main().catch((err) => {
  console.error("Failed to start the server:", err);
});
