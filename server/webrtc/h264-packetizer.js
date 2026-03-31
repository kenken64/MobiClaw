/**
 * H.264 NALU splitter for Annex B streams.
 * Splits a buffer containing one or more NALUs (with start codes) into individual NALUs.
 */
export function splitNalus(data) {
  const nalus = [];
  let start = -1;

  for (let i = 0; i < data.length - 2; i++) {
    // Look for start codes: 00 00 01 or 00 00 00 01
    if (data[i] === 0 && data[i + 1] === 0) {
      let scLen = 0;
      if (data[i + 2] === 1) {
        scLen = 3;
      } else if (i + 3 < data.length && data[i + 2] === 0 && data[i + 3] === 1) {
        scLen = 4;
      }
      if (scLen > 0) {
        if (start !== -1) {
          nalus.push(data.subarray(start, i));
        }
        start = i + scLen;
        i += scLen - 1;
      }
    }
  }

  // Last NALU
  if (start !== -1 && start < data.length) {
    nalus.push(data.subarray(start));
  }

  // If no start codes found, treat entire buffer as one NALU
  if (nalus.length === 0 && data.length > 0) {
    nalus.push(data);
  }

  return nalus;
}

/**
 * Get NALU type from first byte.
 */
export function naluType(nalu) {
  return nalu[0] & 0x1f;
}

// NALU types
export const NALU_SPS = 7;
export const NALU_PPS = 8;
export const NALU_IDR = 5;
export const NALU_NON_IDR = 1;
