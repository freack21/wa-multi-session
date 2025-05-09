import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  WASocket,
} from "@whiskeysockets/baileys";
import path from "path";
import { Boom } from "@hapi/boom";
import fs from "fs";
import type {
  GroupMemberUpdated,
  MessageReceived,
  MessageUpdated,
  StartSessionParams,
} from "../Types";
import { CALLBACK_KEY, CREDENTIALS, Messages } from "../Defaults";
import {
  saveDocumentHandler,
  saveImageHandler,
  saveVideoHandler,
} from "../Utils/save-media";
import { WhatsappError } from "../Error";
import { parseMessageStatusCodeToReadable } from "../Utils/message-status";
import { phoneToJid, to } from "../Utils";

const sessions: Map<string, WASocket> = new Map();

const callback: Map<string, Function> = new Map();

const retryCount: Map<string, number> = new Map();

const P = require("pino")({
  level: "silent",
});

function getMediaMimeType(conversation: any): string {
  if (!conversation?.message) return "";

  const {
    imageMessage,
    videoMessage,
    documentMessage,
    audioMessage,
    documentWithCaptionMessage,
  } = conversation?.message || {};

  return to.string(
    imageMessage?.mimetype ??
      audioMessage?.mimetype ??
      videoMessage?.mimetype ??
      documentMessage?.mimetype ??
      documentWithCaptionMessage?.message?.documentMessage?.mimetype
  );
}

const initializeSocket = async (
  sock: WASocket,
  sessionId: string,
  options: StartSessionParams,
  startSocket: Function,
  saveCreds: Function
): Promise<void> => {
  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect } = update;
      if (update.qr) {
        callback.get(CALLBACK_KEY.ON_QR)?.({
          sessionId,
          qr: update.qr,
        });
        options.onQRUpdated?.(update.qr);
      }
      if (connection == "connecting") {
        callback.get(CALLBACK_KEY.ON_CONNECTING)?.(sessionId);
        options.onConnecting?.();
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        let retryAttempt = retryCount.get(sessionId) ?? 0;
        let shouldRetry;
        if (code != DisconnectReason.loggedOut && retryAttempt < 10) {
          shouldRetry = true;
        }
        if (shouldRetry) {
          retryAttempt++;
          retryCount.set(sessionId, retryAttempt);
          startSocket();
        } else {
          retryCount.delete(sessionId);
          deleteSession(sessionId);
          callback.get(CALLBACK_KEY.ON_DISCONNECTED)?.(sessionId);
          options.onDisconnected?.();
        }
      }
      if (connection == "open") {
        retryCount.delete(sessionId);
        callback.get(CALLBACK_KEY.ON_CONNECTED)?.(sessionId);
        options.onConnected?.();
      }
    }
    if (events["creds.update"]) {
      await saveCreds();
    }
    if (events["messages.update"]) {
      const msg = events["messages.update"][0];
      const mimeType = getMediaMimeType(msg);
      const media = { mimeType, data: "" };
      if (mimeType !== "") {
        const mediaBuffer = await downloadMediaMessage(msg, "buffer", {});
        media.data = mediaBuffer.toString("base64");
      }

      const data: MessageUpdated = {
        sessionId: sessionId,
        messageStatus: parseMessageStatusCodeToReadable(msg.update.status!),
        ...msg,
        ...media,
      };
      callback.get(CALLBACK_KEY.ON_MESSAGE_UPDATED)?.(sessionId, data);
      options.onMessageUpdated?.(data);
    }
    if (events["messages.upsert"]) {
      let msg = events["messages.upsert"]
        .messages?.[0] as unknown as MessageReceived;
      const mimeType = getMediaMimeType(msg);
      const media = { mimeType, data: "" };
      if (mimeType !== "") {
        const mediaBuffer = await downloadMediaMessage(msg, "buffer", {});
        media.data = mediaBuffer.toString("base64");
      }

      const from = msg.key.remoteJid || "";
      const participant = msg.key.participant || "";
      const isGroup = from.includes("@g.us");
      const isStory = from.includes("status@broadcast");
      const myJid = phoneToJid({ to: sock.user.id.split(":")[0] });

      msg.author = from;
      if (isStory || isGroup) msg.author = participant;

      if (msg.key.fromMe) msg.author = myJid;

      msg.media = media;
      msg.sessionId = sessionId;
      msg.saveImage = (path) => saveImageHandler(msg, path);
      msg.saveVideo = (path) => saveVideoHandler(msg, path);
      msg.saveDocument = (path) => saveDocumentHandler(msg, path);
      callback.get(CALLBACK_KEY.ON_MESSAGE_RECEIVED)?.({
        ...msg,
      });
      options.onMessageReceived?.(msg);
    }

    if (events["group-participants.update"]) {
      const dataupdate = {
        ...events["group-participants.update"],
        sessionId,
      };
      options.onGroupMemberUpdate?.(dataupdate);
      callback.get(CALLBACK_KEY.ON_GROUP_MEMBER_UPDATE)?.(dataupdate);
    }
  });
};

/**
 * Start WhatsApp session with QR method
 */
export const startSessionWithQR = async (
  sessionId = "mysession",
  options: StartSessionParams = { printQR: true }
): Promise<WASocket> => {
  if (isSessionExistAndRunning(sessionId))
    throw new WhatsappError(Messages.sessionAlreadyExist(sessionId));

  const { version } = await fetchLatestBaileysVersion();
  const startSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    );
    const sock: WASocket = makeWASocket({
      version,
      printQRInTerminal: options.printQR,
      auth: state,
      logger: P,
      markOnlineOnConnect: false,
      browser: Browsers.ubuntu("Chrome"),
    });
    sessions.set(sessionId, { ...sock });
    try {
      await initializeSocket(sock, sessionId, options, startSocket, saveCreds);

      return sock;
    } catch (error) {
      // console.log("SOCKET ERROR", error);
      return sock;
    }
  };
  return startSocket();
};

/**
 * Start WhatsApp session with pairing code method
 */
export const startSessionWithPairingCode = async (
  sessionId: string,
  options: StartSessionParams
): Promise<WASocket> => {
  if (isSessionExistAndRunning(sessionId))
    throw new WhatsappError(Messages.sessionAlreadyExist(sessionId));

  const { version } = await fetchLatestBaileysVersion();
  const startSocket = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    );
    const sock: WASocket = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: state,
      logger: P,
      markOnlineOnConnect: false,
      browser: Browsers.ubuntu("Chrome"),
    });
    sessions.set(sessionId, { ...sock });
    try {
      if (!sock.authState.creds.registered) {
        const code = await sock.requestPairingCode(options.phoneNumber);
        callback.get(CALLBACK_KEY.ON_PAIRING_CODE)?.(sessionId, code);
        options.onPairingCode?.(code);
      }

      await initializeSocket(sock, sessionId, options, startSocket, saveCreds);

      return sock;
    } catch (error) {
      // console.log("SOCKET ERROR", error);
      return sock;
    }
  };
  return startSocket();
};

/**
 * start WhatsApp session
 */
export const startWhatsapp = (
  sessionId: string,
  options: StartSessionParams = { printQR: true, pairCode: false }
): Promise<WASocket> => {
  if (options.pairCode) {
    return startSessionWithPairingCode(sessionId, options);
  }
  return startSessionWithQR(sessionId, options);
};

export const deleteSession = async (sessionId: string) => {
  const session = getSession(sessionId);
  try {
    await session?.logout();
  } catch (error) {}
  session?.end(undefined);
  sessions.delete(sessionId);
  const dir = path.resolve(
    CREDENTIALS.DIR_NAME,
    sessionId + CREDENTIALS.PREFIX
  );
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
};
export const getAllSession = (): string[] => Array.from(sessions.keys());

export const getSession = (key: string): WASocket | undefined =>
  sessions.get(key) as WASocket;

const isSessionExistAndRunning = (sessionId: string): boolean => {
  if (
    fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME)) &&
    fs.existsSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ) &&
    fs.readdirSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ).length &&
    getSession(sessionId)
  ) {
    return true;
  }
  return false;
};
const shouldLoadSession = (sessionId: string): boolean => {
  if (
    fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME)) &&
    fs.existsSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ) &&
    fs.readdirSync(
      path.resolve(CREDENTIALS.DIR_NAME, sessionId + CREDENTIALS.PREFIX)
    ).length &&
    !getSession(sessionId)
  ) {
    return true;
  }
  return false;
};

export const loadSessionsFromStorage = () => {
  if (!fs.existsSync(path.resolve(CREDENTIALS.DIR_NAME))) {
    fs.mkdirSync(path.resolve(CREDENTIALS.DIR_NAME));
  }
  fs.readdir(path.resolve(CREDENTIALS.DIR_NAME), async (err, dirs) => {
    if (err) {
      throw err;
    }
    for (const dir of dirs) {
      const sessionId = dir.split("_")[0];
      if (!shouldLoadSession(sessionId)) continue;
      startSessionWithQR(sessionId);
    }
  });
};

export const onMessageReceived = (listener: (msg: MessageReceived) => any) => {
  callback.set(CALLBACK_KEY.ON_MESSAGE_RECEIVED, listener);
};
export const onQRUpdated = (
  listener: ({ sessionId, qr }: { sessionId: string; qr: string }) => any
) => {
  callback.set(CALLBACK_KEY.ON_QR, listener);
};
export const onConnected = (listener: (sessionId: string) => any) => {
  callback.set(CALLBACK_KEY.ON_CONNECTED, listener);
};
export const onDisconnected = (listener: (sessionId: string) => any) => {
  callback.set(CALLBACK_KEY.ON_DISCONNECTED, listener);
};
export const onConnecting = (listener: (sessionId: string) => any) => {
  callback.set(CALLBACK_KEY.ON_CONNECTING, listener);
};

export const onMessageUpdate = (listener: (data: MessageUpdated) => any) => {
  callback.set(CALLBACK_KEY.ON_MESSAGE_UPDATED, listener);
};

export const onPairingCode = (
  listener: (sessionId: string, code: string) => any
) => {
  callback.set(CALLBACK_KEY.ON_PAIRING_CODE, listener);
};

export const onGroupMemberUpdate = (
  listener: (data: GroupMemberUpdated) => any
) => {
  callback.set(CALLBACK_KEY.ON_GROUP_MEMBER_UPDATE, listener);
};
