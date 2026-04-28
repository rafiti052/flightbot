export function createNotifier({ log, formatMessage }) {
  async function sendTelegram(token, chatId, message) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        log(`Telegram error ${res.status}: ${body}`);
      } else {
        log("Telegram alert sent successfully");
      }
    } catch (e) {
      log(`Telegram send failed: ${e.message}`);
    }
  }

  async function sendRouteAlert({ route, best, alertType, telegram }) {
    const bestRoute = best._variant ?? route;
    const message = formatMessage(bestRoute, best, alertType);
    await sendTelegram(telegram.token, telegram.chatId, message);
  }

  return { sendRouteAlert };
}
