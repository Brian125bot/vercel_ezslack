import net from 'net';
import dns from 'dns';

/**
 * SHARED SSRF-GUARD MODULE
 *
 * This module blocks requests to internal, reserved, loopback, or private network ranges.
 * It also protects against open-redirect bypasses during redirect tracking.
 *
 * NOTE ON SCOPE:
 * This implementation closes direct-IP-targeting and redirect-based bypass.
 * It does NOT provide full DNS-rebinding defense (which would require pinning the TCP
 * connection to a pre-validated IP via a custom undici dispatcher / connection-level control).
 * DNS-rebinding remains a known, deliberately deferred residual limitation.
 */

const BLOCKED_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16', // Cloud metadata address range
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32'
];

const BLOCKED_IPV6_CIDRS = [
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8'
];

/**
 * Converts an IPv4 string (e.g. "127.0.0.1") to an unsigned 32-bit integer.
 */
function ipv4ToLong(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error('Invalid IPv4 format');
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Checks if a given IPv4 integer falls within a CIDR prefix.
 */
function ipv4InCidr(ipLong: number, cidr: string): boolean {
  const [prefix, maskStr] = cidr.split('/');
  const mask = parseInt(maskStr, 10);
  const prefixLong = ipv4ToLong(prefix);
  if (mask === 0) {
    return true;
  }
  const maskLong = (mask === 32 ? 0xffffffff : ~((1 << (32 - mask)) - 1)) >>> 0;
  return (ipLong & maskLong) === (prefixLong & maskLong);
}

/**
 * Normalizes and converts an IPv6 string to a 128-bit BigInt.
 * Also handles standard IPv6 abbreviations with "::".
 */
function ipv6ToBigInt(ip: string): bigint {
  const address = ip.trim().toLowerCase();

  const parts = address.split('::');
  if (parts.length > 2) {
    throw new Error('Invalid IPv6 address (multiple ::)');
  }

  let left = parts[0] ? parts[0].split(':') : [];
  let right = parts[1] ? parts[1].split(':') : [];

  // Handle IPv4 representation in the last block of IPv6 (e.g., ::ffff:192.168.0.1)
  if (right.length > 0 && right[right.length - 1].includes('.')) {
    const ipv4Str = right.pop()!;
    const ipv4Parts = ipv4Str.split('.').map(Number);
    if (ipv4Parts.length !== 4 || ipv4Parts.some(isNaN)) {
      throw new Error('Invalid embedded IPv4');
    }
    const block1 = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const block2 = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    right.push(block1, block2);
  } else if (left.length > 0 && left[left.length - 1].includes('.')) {
    const ipv4Str = left.pop()!;
    const ipv4Parts = ipv4Str.split('.').map(Number);
    if (ipv4Parts.length !== 4 || ipv4Parts.some(isNaN)) {
      throw new Error('Invalid embedded IPv4');
    }
    const block1 = ((ipv4Parts[0] << 8) | ipv4Parts[1]).toString(16);
    const block2 = ((ipv4Parts[2] << 8) | ipv4Parts[3]).toString(16);
    left.push(block1, block2);
  }

  const fillCount = 8 - (left.length + right.length);
  if (fillCount < 0) {
    throw new Error('Invalid IPv6 structure');
  }
  const middle = Array(fillCount).fill('0');
  const allBlocks = [...left, ...middle, ...right];

  let result = 0n;
  for (const block of allBlocks) {
    const parsed = parseInt(block || '0', 16);
    if (isNaN(parsed) || parsed < 0 || parsed > 0xffff) {
      throw new Error(`Invalid hex block: ${block}`);
    }
    result = (result << 16n) + BigInt(parsed);
  }
  return result;
}

/**
 * Checks if a given IPv6 BigInt falls within an IPv6 CIDR.
 */
function ipv6InCidr(ipBigInt: bigint, cidr: string): boolean {
  const [prefix, maskStr] = cidr.split('/');
  const mask = parseInt(maskStr, 10);
  const prefixBigInt = ipv6ToBigInt(prefix);
  if (mask === 0) {
    return true;
  }
  const maskBigInt = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - mask)) - 1n);
  return (ipBigInt & maskBigInt) === (prefixBigInt & maskBigInt);
}

/**
 * Verifies if an IP address string is safe (not in blocked ranges).
 */
export function isIpSafe(ip: string): { safe: boolean; reason?: string } {
  if (net.isIPv4(ip)) {
    try {
      const ipLong = ipv4ToLong(ip);
      for (const cidr of BLOCKED_IPV4_CIDRS) {
        if (ipv4InCidr(ipLong, cidr)) {
          return { safe: false, reason: `IPv4 matches blocked CIDR ${cidr}` };
        }
      }
      return { safe: true };
    } catch (err: any) {
      return { safe: false, reason: `Invalid IPv4: ${err.message}` };
    }
  } else if (net.isIPv6(ip)) {
    try {
      const ipBigInt = ipv6ToBigInt(ip);

      // Unwrap IPv4-mapped/translated forms
      const isIpv4Mapped = ipv6InCidr(ipBigInt, '::ffff:0:0/96');
      const isIpv4Translated = ipv6InCidr(ipBigInt, '64:ff9b::/96');
      if (isIpv4Mapped || isIpv4Translated) {
        const ipv4Long = Number(ipBigInt & 0xffffffffn);
        const part1 = (ipv4Long >>> 24) & 0xff;
        const part2 = (ipv4Long >>> 16) & 0xff;
        const part3 = (ipv4Long >>> 8) & 0xff;
        const part4 = ipv4Long & 0xff;
        const unwrappedIpv4 = `${part1}.${part2}.${part3}.${part4}`;

        const unwrappedResult = isIpSafe(unwrappedIpv4);
        if (!unwrappedResult.safe) {
          return { safe: false, reason: `Unwrapped IPv4 ${unwrappedIpv4} is unsafe: ${unwrappedResult.reason}` };
        }
      }

      for (const cidr of BLOCKED_IPV6_CIDRS) {
        if (ipv6InCidr(ipBigInt, cidr)) {
          return { safe: false, reason: `IPv6 matches blocked CIDR ${cidr}` };
        }
      }
      return { safe: true };
    } catch (err: any) {
      return { safe: false, reason: `Invalid IPv6: ${err.message}` };
    }
  } else {
    return { safe: false, reason: 'Invalid IP format' };
  }
}

/**
 * Parses the URL, confirms protocol, and verifies all resolved IP addresses
 * against the private/reserved-range denylist.
 */
export async function isUrlSafe(url: string): Promise<{ safe: boolean; reason?: string }> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { safe: false, reason: 'Invalid URL format' };
  }

  // Confirm protocol is http/https
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { safe: false, reason: 'Invalid protocol' };
  }

  const hostname = parsedUrl.hostname;
  if (!hostname) {
    return { safe: false, reason: 'Empty hostname' };
  }

  // If hostname is directly an IP literal
  if (net.isIP(hostname)) {
    const ipCheck = isIpSafe(hostname);
    if (!ipCheck.safe) {
      return { safe: false, reason: ipCheck.reason };
    }
    return { safe: true };
  }

  // Resolve hostname via dns.promises.lookup
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (err: any) {
    // Treat DNS failure as unsafe (fail closed)
    return { safe: false, reason: `DNS resolution failed: ${err.message}` };
  }

  if (!addresses || addresses.length === 0) {
    return { safe: false, reason: 'No DNS records found' };
  }

  // Check every resolved address
  for (const { address } of addresses) {
    const ipCheck = isIpSafe(address);
    if (!ipCheck.safe) {
      return { safe: false, reason: `Resolved IP ${address} is unsafe: ${ipCheck.reason}` };
    }
  }

  return { safe: true };
}

/**
 * Drop-in fetch replacement that ensures SSRF safety before every hop,
 * including redirects.
 */
export async function safeFetch(
  url: string,
  options: RequestInit = {},
  maxRedirects: number = 5
): Promise<Response> {
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    const safety = await isUrlSafe(currentUrl);
    if (!safety.safe) {
      throw new Error('blocked: destination not allowed');
    }

    const fetchOptions: RequestInit = {
      ...options,
      redirect: 'manual'
    };

    const response = await fetch(currentUrl, fetchOptions);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return response; // No location header, let consumer handle or treat as final
      }

      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error('Max redirects exceeded');
      }

      // Resolve location relative to currentUrl (handles relative redirects)
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return response;
  }
}
