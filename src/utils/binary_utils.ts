/**
 * Binary data conversion utilities
 */

/**
 * Convert ArrayBuffer to Base64 string in a browser-compatible way.
 * This is a pure function that works in all browser contexts (content scripts, workers, service workers).
 *
 * Uses chunked processing to avoid O(n²) string concatenation and prevent stack overflow.
 * Performance: ~10-100x faster than naive byte-by-byte concatenation for large files (5MB+).
 *
 * @param buffer - The ArrayBuffer to convert
 * @returns Base64-encoded string
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000; // 32KB chunks (32768 bytes) - prevents stack overflow
  let binary = "";

  // Process in chunks to avoid per-byte string concatenation (O(n²)) and stack overflow
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length));
    // String.fromCharCode.apply is much faster than concatenating individual chars
    // Array.from converts Uint8Array to number[], which is compatible with apply's ArrayLike<number>
    const chunkArray = Array.from(chunk) as number[];
    binary += String.fromCharCode.apply(null, chunkArray);
  }

  return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer in a browser-compatible way.
 * Handles both raw base64 strings and data URLs (e.g., "data:image/png;base64,...")
 *
 * @param base64 - The Base64 string to convert (raw or data URL)
 * @returns ArrayBuffer containing the decoded binary data
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  // Strip data URL prefix if present (e.g., "data:image/png;base64,")
  const base64Data = base64.includes(",") ? base64.split(",")[1] : base64;

  // Decode base64 to binary string
  const binaryString = atob(base64Data);

  // Convert binary string to Uint8Array
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes.buffer;
}

/**
 * Extract MIME type from a data URL.
 *
 * @param dataUrl - The data URL (e.g., "data:image/png;base64,...")
 * @returns The MIME type (e.g., "image/png") or "application/octet-stream" if not found
 */
export function getMimeTypeFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:([^;,]+)/);
  return match ? match[1] : "application/octet-stream";
}
