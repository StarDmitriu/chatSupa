/**
 * Мок @whiskeysockets/baileys для e2e-тестов (Jest не обрабатывает ESM этот пакет).
 * Экспортирует заглушки, достаточные для загрузки WhatsappService при старте приложения.
 */

function makeWASocket() {
  return {};
}

function useMultiFileAuthState() {
  return {
    state: {},
    saveCreds: function () {},
  };
}

const DisconnectReason = {};

async function fetchLatestBaileysVersion() {
  return { version: [2, 2323, 4], isLatest: true };
}

const WASocket = {};

module.exports = {
  __esModule: true,
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  WASocket,
};
