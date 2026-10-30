export interface Ax25Addressing {
  source: string;
  destination: string;
  path: string[];
}

export type AprsType =
  | 'Position'
  | 'Position (Mic-E)'
  | 'Weather'
  | 'Status'
  | 'Message'
  | 'Telemetry'
  | 'Object'
  | 'Item'
  | 'Third party'
  | 'Capabilities'
  | 'Query'
  | 'Unknown';

export interface AprsWeather {
  windDirDeg?: number;
  windMph?: number;
  gustMph?: number;
  tempF?: number;
  humidityPct?: number;
  pressureMb?: number;
}

export interface AprsPacket extends Ax25Addressing {
  info: string;
  raw: string;
  type: AprsType;
  latitude?: number;
  longitude?: number;
  symbol?: string;
  courseDeg?: number;
  speedKnots?: number;
  altitudeFt?: number;
  comment?: string;
  weather?: AprsWeather;
  message?: { to: string; text: string; id?: string };
  objectName?: string;
}

const UNCOMPRESSED = /^(\d{2})(\d{2}\.[\d ]{2})([NS])(.)(\d{3})(\d{2}\.[\d ]{2})([EW])(.)(.*)$/s;

export function parseAprs(frame: Ax25Addressing & { info: string }): AprsPacket {
  const { source, destination, path, info } = frame;
  const via = path.length ? `,${path.join(',')}` : '';
  const p: AprsPacket = {
    source,
    destination,
    path,
    info,
    raw: `${source}>${destination}${via}:${info}`,
    type: 'Unknown',
  };

  switch (info[0]) {
    case '!':
    case '=':
      p.type = 'Position';
      parsePosition(p, info.slice(1));
      break;
    case '/':
    case '@':
      p.type = 'Position';
      parsePosition(p, info.slice(8));
      break;
    case '`':
    case "'":
      p.type = 'Position (Mic-E)';
      parseMicE(p, destination, info);
      break;
    case '>':
      p.type = 'Status';
      p.comment = info.slice(1).trim();
      break;
    case ':':
      p.type = 'Message';
      parseMessage(p, info);
      break;
    case '_':
      p.type = 'Weather';
      p.weather = parseWeather(info.slice(9), true);
      break;
    case 'T':
      p.type = 'Telemetry';
      p.comment = info.slice(1).trim();
      break;
    case ';':
      p.type = 'Object';
      p.objectName = info.slice(1, 10).trim();
      parsePosition(p, info.slice(18));
      break;
    case ')': {
      p.type = 'Item';
      const m = /^\)(.{3,9}?)[!_](.*)$/s.exec(info);
      if (m) {
        p.objectName = m[1].trim();
        parsePosition(p, m[2]);
      }
      break;
    }
    case '}':
      p.type = 'Third party';
      p.comment = info.slice(1);
      break;
    case '<':
      p.type = 'Capabilities';
      p.comment = info.slice(1);
      break;
    case '?':
      p.type = 'Query';
      p.comment = info.slice(1);
      break;
  }
  return p;
}

function parsePosition(p: AprsPacket, body: string) {
  const m = UNCOMPRESSED.exec(body);
  if (m) {
    const lat = Number(m[1]) + Number(m[2].replace(/ /g, '0')) / 60;
    const lon = Number(m[5]) + Number(m[6].replace(/ /g, '0')) / 60;
    if (lat > 90 || lon > 180) return;
    p.latitude = m[3] === 'S' ? -lat : lat;
    p.longitude = m[7] === 'W' ? -lon : lon;
    p.symbol = m[4] + m[8];
    parseExtensionAndComment(p, m[8], m[9]);
    return;
  }
  parseCompressed(p, body);
}

/** Compressed format: table, 4 lat, 4 lon, symbol, course/speed pair, type, comment. */
function parseCompressed(p: AprsPacket, body: string) {
  if (body.length < 13) return;
  const lat = base91(body.slice(1, 5));
  const lon = base91(body.slice(5, 9));
  if (lat === null || lon === null) return;
  p.latitude = 90 - lat / 380926;
  p.longitude = -180 + lon / 190463;
  p.symbol = body[0] + body[9];

  const c = body.charCodeAt(10) - 33;
  const s = body.charCodeAt(11) - 33;
  const type = body.charCodeAt(12) - 33;
  if (c >= 0 && c <= 90 && s >= 0) {
    if ((type & 0x18) === 0x10) {
      p.altitudeFt = Math.round(1.002 ** (c * 91 + s));
    } else if (c <= 89) {
      p.courseDeg = c * 4;
      p.speedKnots = 1.08 ** s - 1;
    }
  }
  parseExtensionAndComment(p, body[9], body.slice(13), false);
}

function base91(text: string): number | null {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    const d = text.charCodeAt(i) - 33;
    if (d < 0 || d > 90) return null;
    value = value * 91 + d;
  }
  return value;
}

function parseExtensionAndComment(p: AprsPacket, symbolCode: string, rest: string, courseSpeed = true) {
  let comment = rest;
  const ext = courseSpeed ? /^(\d{3})\/(\d{3})/.exec(comment) : null;
  if (symbolCode === '_') {
    p.type = 'Weather';
    p.weather = parseWeather(comment, false);
    return;
  }
  if (ext) {
    p.courseDeg = Number(ext[1]);
    p.speedKnots = Number(ext[2]);
    comment = comment.slice(7);
  }
  const alt = /\/A=(\d{6})/.exec(comment);
  if (alt) {
    p.altitudeFt = Number(alt[1]);
    comment = comment.replace(alt[0], '').replace(/ {2,}/g, ' ');
  }
  comment = comment.trim();
  if (comment) p.comment = comment;
}

function parseMicE(p: AprsPacket, destination: string, info: string) {
  const dest = destination.split('-')[0];
  if (dest.length !== 6 || info.length < 9 || !/^[0-9A-LP-Z]{6}$/.test(dest)) return;

  let digits = '';
  for (const ch of dest) digits += micEDigit(ch);
  const lat = Number(digits.slice(0, 2)) + Number(`${digits.slice(2, 4)}.${digits.slice(4, 6)}`) / 60;
  const isHigh = (i: number) => dest[i] >= 'P' && dest[i] <= 'Z';

  let lonDeg = info.charCodeAt(1) - 28 + (isHigh(4) ? 100 : 0);
  if (lonDeg >= 180 && lonDeg <= 189) lonDeg -= 80;
  else if (lonDeg >= 190 && lonDeg <= 199) lonDeg -= 190;
  let lonMin = info.charCodeAt(2) - 28;
  if (lonMin >= 60) lonMin -= 60;
  const lon = lonDeg + (lonMin + (info.charCodeAt(3) - 28) / 100) / 60;
  if (lat > 90 || lon > 180) return;

  p.latitude = isHigh(3) ? lat : -lat;
  p.longitude = isHigh(5) ? -lon : lon;

  const sp = info.charCodeAt(4) - 28;
  const dc = info.charCodeAt(5) - 28;
  const se = info.charCodeAt(6) - 28;
  const speed = sp * 10 + Math.floor(dc / 10);
  const course = (dc % 10) * 100 + se;
  p.speedKnots = speed >= 800 ? speed - 800 : speed;
  p.courseDeg = course >= 400 ? course - 400 : course;
  p.symbol = info[8] + info[7];

  const comment = info.slice(9).replace(/^[\]>`'\s]+/, '').trim();
  if (comment) p.comment = comment;
}

function micEDigit(ch: string): string {
  if (ch >= '0' && ch <= '9') return ch;
  if (ch >= 'A' && ch <= 'J') return String(ch.charCodeAt(0) - 65);
  if (ch >= 'P' && ch <= 'Y') return String(ch.charCodeAt(0) - 80);
  return '0'; // K, L and Z mean position ambiguity.
}

function parseMessage(p: AprsPacket, info: string) {
  if (info.length < 11 || info[10] !== ':') return;
  const body = info.slice(11);
  const brace = body.lastIndexOf('{');
  p.message = {
    to: info.slice(1, 10).trim(),
    text: brace >= 0 ? body.slice(0, brace) : body,
  };
  if (brace >= 0) p.message.id = body.slice(brace + 1);
}

function parseWeather(text: string, positionless: boolean): AprsWeather {
  const w: AprsWeather = {};
  const field = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const set = <K extends keyof AprsWeather>(key: K, value: number | undefined) => {
    if (value !== undefined) w[key] = value;
  };

  if (positionless) {
    set('windDirDeg', field(/c(\d{3})/));
    set('windMph', field(/s(\d{3})/));
  } else {
    const ext = /^(\d{3})\/(\d{3})/.exec(text);
    if (ext) {
      w.windDirDeg = Number(ext[1]);
      w.windMph = Number(ext[2]);
    }
  }
  set('gustMph', field(/g(\d{3})/));
  set('tempF', field(/t(-?\d{2,3})/));
  const humidity = field(/h(\d{2})/);
  if (humidity !== undefined) w.humidityPct = humidity === 0 ? 100 : humidity;
  const pressure = field(/b(\d{5})/);
  if (pressure !== undefined) w.pressureMb = pressure / 10;
  return w;
}
