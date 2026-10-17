import { deflateSync } from "node:zlib";
import type { InspectionResult } from "../server/scan/contract.js";

/** Build a real, decodable PNG of the given size (solid colour, with noise rows so it exceeds the size floor). */
export function makePng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 0 })), chunk("IEND", Buffer.alloc(0))]);
}

export function baseResult(overrides: Partial<InspectionResult> = {}): InspectionResult {
  return {
    contractVersion: 1,
    requestedUrl: "https://shop.example.org/",
    finalUrl: "https://shop.example.org/",
    httpStatus: 200,
    redirectChain: [{ url: "https://shop.example.org/", status: 200, kind: "initial" }],
    title: "Example Shop",
    claimedIdentity: { siteName: null, brandMentions: [], evidence: [] },
    forms: [],
    loginFormDetected: false,
    textSignals: { urgencyPhrases: [], credentialRequests: [], instructionsToAI: [] },
    visibleTextSample: "Welcome",
    externalScriptOrigins: [],
    blockedRequests: [],
    contactedHosts: [],
    screenshot: { path: "/tmp/teger/out/screenshot.png", bytes: 5000 },
    screenshotError: null,
    extractionErrors: [],
    notes: [],
    ...overrides,
  };
}
