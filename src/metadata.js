'use strict';
// usy-fork: metadata.js
//
// Embeds the originating tweet's info directly into a saved image file,
// rather than only encoding it into the filename:
//   - JPEG -> real EXIF fields (Artist, ImageDescription, UserComment) via piexifjs
//   - PNG  -> standard tEXt chunks (Author, Description, Source, Comment)
// Any other format is left untouched by the caller (see prepareDownloadUrl
// in background.js), since there's no equally simple, universally-readable
// place to put text metadata in e.g. webp/gif without extra dependencies.

/**
 * @typedef {Object} TweetMetadata
 * @property {string} author   - the tweet author's @handle (no leading @)
 * @property {string} tweetId
 * @property {string} sourceUrl - link back to the tweet
 */

// ---------- shared byte/base64 helpers (no FileReader - service-worker safe) ----------

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string} base64
 */
function bytesToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {string} mime
 * @returns {string} data: URL
 */
function bytesToDataUrl(buffer, mime) {
    return `data:${mime};base64,${bytesToBase64(buffer)}`;
}

/**
 * @param {string} dataUrl
 * @returns {Uint8Array}
 */
function dataUrlToBytes(dataUrl) {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function tweetDescription(meta) {
    return `Tweet by @${meta.author} (status ${meta.tweetId}) - ${meta.sourceUrl}`;
}

// ---------------------------- JPEG (EXIF via piexifjs) ----------------------------

/**
 * @param {ArrayBuffer} jpegBuffer
 * @param {TweetMetadata} meta
 * @returns {string} data: URL of the JPEG with metadata embedded
 */
function embedJpegMetadata(jpegBuffer, meta) {
    const dataUrl = bytesToDataUrl(jpegBuffer, 'image/jpeg');

    let exifObj;
    try {
        exifObj = piexif.load(dataUrl);
    } catch (e) {
        exifObj = {'0th': {}, Exif: {}, GPS: {}, '1st': {}, thumbnail: null};
    }
    exifObj['0th'] ||= {};
    exifObj['Exif'] ||= {};

    exifObj['0th'][piexif.ImageIFD.Artist] = `@${meta.author}`;
    exifObj['0th'][piexif.ImageIFD.ImageDescription] = tweetDescription(meta);
    exifObj['0th'][piexif.ImageIFD.Software] = 'Improvements for Twitter (fork)';
    exifObj['Exif'][piexif.ExifIFD.UserComment] =
        'ASCII\0\0\0' + JSON.stringify({author: meta.author, tweet_id: meta.tweetId, source_url: meta.sourceUrl});

    const exifBytes = piexif.dump(exifObj);
    return piexif.insert(exifBytes, dataUrl);
}

// ----------------------------- PNG (manual tEXt chunks) -----------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function u32be(n) {
    return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concatBytes(arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of arrays) {
        out.set(a, offset);
        offset += a.length;
    }
    return out;
}

function makeTextChunk(keyword, text) {
    const encoder = new TextEncoder();
    const data = concatBytes([encoder.encode(keyword), new Uint8Array([0]), encoder.encode(text)]);
    const typeAndData = concatBytes([encoder.encode('tEXt'), data]);
    return concatBytes([u32be(data.length), typeAndData, u32be(crc32(typeAndData))]);
}

/**
 * @param {ArrayBuffer} pngBuffer
 * @param {TweetMetadata} meta
 * @returns {string} data: URL of the PNG with metadata chunks embedded
 */
function embedPngMetadata(pngBuffer, meta) {
    const bytes = new Uint8Array(pngBuffer);
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('Not a valid PNG file');
    }

    const chunks = [
        makeTextChunk('Author', `@${meta.author}`),
        makeTextChunk('Description', tweetDescription(meta)),
        makeTextChunk('Source', meta.sourceUrl),
        makeTextChunk('Comment', JSON.stringify({author: meta.author, tweet_id: meta.tweetId, source_url: meta.sourceUrl}))
    ];

    // IHDR is always the first chunk after the signature, and always
    // 4(len)+4(type)+13(data)+4(crc) = 25 bytes, so this offset is fixed.
    const IHDR_TOTAL_LEN = 25;
    const insertAt = PNG_SIGNATURE.length + IHDR_TOTAL_LEN;

    const merged = concatBytes([bytes.slice(0, insertAt), ...chunks, bytes.slice(insertAt)]);
    return bytesToDataUrl(merged, 'image/png');
}
