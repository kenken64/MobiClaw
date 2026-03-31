/**
 * Screen perception: reads the UI accessibility tree and captures screenshots.
 * Uses uiautomator dump + screencap via ADB.
 */
import { getClient } from '../adb/adb-client.js';

const DUMP_PATH = '/sdcard/window_dump.xml';

/**
 * Dump the accessibility tree and parse interactive UI elements.
 */
export async function getScreenElements(serial) {
  const device = getClient().getDevice(serial);

  // Dump UI hierarchy
  try {
    await shell(device, `uiautomator dump ${DUMP_PATH}`);
  } catch {
    return { elements: [], raw: '' };
  }

  // Pull the XML
  const stream = await device.shell(`cat ${DUMP_PATH}`);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const xml = Buffer.concat(chunks).toString('utf-8').replace(/\r/g, '');

  // Parse elements
  const elements = parseElements(xml);
  return { elements, raw: xml };
}

/**
 * Capture screenshot as base64 PNG.
 */
export async function captureScreenshot(serial) {
  const device = getClient().getDevice(serial);
  try {
    const stream = await device.shell('exec-out screencap -p');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.length < 100 || buffer[0] !== 0x89) return null;
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

/**
 * Get the foreground app package name.
 */
export async function getForegroundApp(serial) {
  const device = getClient().getDevice(serial);
  try {
    // Android 16 uses topResumedActivity, older uses mResumedActivity
    const out = await shellOutput(device, 'dumpsys activity activities');
    // Try multiple patterns
    const patterns = [
      /topResumedActivity=.*?([a-zA-Z][a-zA-Z0-9_.]+)\//,
      /mResumedActivity=.*?([a-zA-Z][a-zA-Z0-9_.]+)\//,
      /mFocusedApp=.*?([a-zA-Z][a-zA-Z0-9_.]+)\//,
    ];
    for (const pattern of patterns) {
      const match = out.match(pattern);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse the UI XML into interactive elements with bounds.
 */
function parseElements(xml) {
  const elements = [];
  // Match each <node> element
  const nodeRegex = /<node\s[^>]*>/g;
  let match;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const node = match[0];

    const text = attr(node, 'text');
    const desc = attr(node, 'content-desc');
    const cls = attr(node, 'class');
    const resId = attr(node, 'resource-id');
    const clickable = attr(node, 'clickable') === 'true';
    const enabled = attr(node, 'enabled') === 'true';
    const focusable = attr(node, 'focusable') === 'true';
    const longClickable = attr(node, 'long-clickable') === 'true';
    const scrollable = attr(node, 'scrollable') === 'true';
    const bounds = attr(node, 'bounds');

    // Only include interactive or labeled elements
    const isInteractive = clickable || focusable || longClickable || scrollable;
    const hasLabel = text || desc;
    if (!isInteractive && !hasLabel) continue;
    if (!enabled) continue;
    if (!bounds) continue;

    // Parse bounds "[x1,y1][x2,y2]"
    const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const x1 = parseInt(bm[1]), y1 = parseInt(bm[2]);
    const x2 = parseInt(bm[3]), y2 = parseInt(bm[4]);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);

    // Skip invisible elements (zero size)
    if (x2 <= x1 || y2 <= y1) continue;

    const shortClass = cls ? cls.split('.').pop() : '';

    elements.push({
      index: elements.length,
      text: text || '',
      desc: desc || '',
      type: shortClass,
      id: resId ? resId.split('/').pop() : '',
      clickable,
      scrollable,
      bounds: [x1, y1, x2, y2],
      center: [cx, cy],
    });
  }

  return elements;
}

function attr(node, name) {
  const m = node.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

async function shell(device, cmd) {
  const stream = await device.shell(cmd);
  for await (const _ of stream) {}
}

async function shellOutput(device, cmd) {
  const stream = await device.shell(cmd);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').replace(/\r/g, '').trim();
}
