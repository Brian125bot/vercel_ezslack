import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'dns';
import { isIpSafe, isUrlSafe, safeFetch } from '../src/server/ssrfGuard.js';

describe('isIpSafe', () => {
  it('correctly blocks IPv4 loopback and private/reserved ranges', () => {
    // 0.0.0.0/8
    expect(isIpSafe('0.0.0.0').safe).toBe(false);
    expect(isIpSafe('0.255.255.255').safe).toBe(false);

    // 10.0.0.0/8
    expect(isIpSafe('10.0.0.1').safe).toBe(false);
    expect(isIpSafe('10.255.255.255').safe).toBe(false);

    // 100.64.0.0/10
    expect(isIpSafe('100.64.0.1').safe).toBe(false);
    expect(isIpSafe('100.127.255.255').safe).toBe(false);

    // 127.0.0.0/8
    expect(isIpSafe('127.0.0.1').safe).toBe(false);
    expect(isIpSafe('127.255.255.255').safe).toBe(false);

    // 169.254.0.0/16 (Cloud Metadata Address Range)
    expect(isIpSafe('169.254.169.254').safe).toBe(false);
    expect(isIpSafe('169.254.0.1').safe).toBe(false);

    // 172.16.0.0/12
    expect(isIpSafe('172.16.0.1').safe).toBe(false);
    expect(isIpSafe('172.31.255.255').safe).toBe(false);

    // 192.0.0.0/24
    expect(isIpSafe('192.0.0.1').safe).toBe(false);

    // 192.0.2.0/24
    expect(isIpSafe('192.0.2.1').safe).toBe(false);

    // 192.168.0.0/16
    expect(isIpSafe('192.168.1.1').safe).toBe(false);

    // 198.18.0.0/15
    expect(isIpSafe('198.18.0.1').safe).toBe(false);
    expect(isIpSafe('198.19.255.255').safe).toBe(false);

    // 198.51.100.0/24
    expect(isIpSafe('198.51.100.1').safe).toBe(false);

    // 203.0.113.0/24
    expect(isIpSafe('203.0.113.1').safe).toBe(false);

    // 224.0.0.0/4 (Multicast)
    expect(isIpSafe('224.0.0.1').safe).toBe(false);
    expect(isIpSafe('239.255.255.255').safe).toBe(false);

    // 240.0.0.0/4
    expect(isIpSafe('240.0.0.1').safe).toBe(false);
    expect(isIpSafe('254.255.255.255').safe).toBe(false);

    // 255.255.255.255
    expect(isIpSafe('255.255.255.255').safe).toBe(false);
  });

  it('correctly allows IPv4 addresses just outside blocked ranges (boundary cases)', () => {
    // around 10.0.0.0/8
    expect(isIpSafe('9.255.255.255').safe).toBe(true);
    expect(isIpSafe('11.0.0.0').safe).toBe(true);

    // around 100.64.0.0/10
    expect(isIpSafe('100.63.255.255').safe).toBe(true);
    expect(isIpSafe('100.128.0.0').safe).toBe(true);

    // around 127.0.0.0/8
    expect(isIpSafe('126.255.255.255').safe).toBe(true);
    expect(isIpSafe('128.0.0.0').safe).toBe(true);

    // around 169.254.0.0/16
    expect(isIpSafe('169.253.255.255').safe).toBe(true);
    expect(isIpSafe('169.255.0.0').safe).toBe(true);

    // around 172.16.0.0/12
    expect(isIpSafe('172.15.255.255').safe).toBe(true);
    expect(isIpSafe('172.32.0.0').safe).toBe(true);

    // around 192.168.0.0/16
    expect(isIpSafe('192.167.255.255').safe).toBe(true);
    expect(isIpSafe('192.169.0.0').safe).toBe(true);

    // general public IPs
    expect(isIpSafe('1.1.1.1').safe).toBe(true);
    expect(isIpSafe('8.8.8.8').safe).toBe(true);
    expect(isIpSafe('142.250.190.46').safe).toBe(true);
  });

  it('correctly blocks IPv6 loopback and private/reserved ranges', () => {
    // ::1/128
    expect(isIpSafe('::1').safe).toBe(false);
    expect(isIpSafe('0:0:0:0:0:0:0:1').safe).toBe(false);

    // fc00::/7
    expect(isIpSafe('fc00::1').safe).toBe(false);
    expect(isIpSafe('fd00::1').safe).toBe(false);

    // fe80::/10
    expect(isIpSafe('fe80::1').safe).toBe(false);
    expect(isIpSafe('febf::1').safe).toBe(false);

    // ff00::/8 (multicast)
    expect(isIpSafe('ff00::1').safe).toBe(false);
    expect(isIpSafe('ff02::1').safe).toBe(false);
  });

  it('correctly unwraps and blocks IPv4-mapped/translated forms', () => {
    // ::ffff:a.b.c.d/96
    expect(isIpSafe('::ffff:127.0.0.1').safe).toBe(false);
    expect(isIpSafe('::ffff:169.254.169.254').safe).toBe(false);
    expect(isIpSafe('::ffff:10.0.0.1').safe).toBe(false);
    expect(isIpSafe('::ffff:192.168.1.1').safe).toBe(false);

    // 64:ff9b::/96
    expect(isIpSafe('64:ff9b::127.0.0.1').safe).toBe(false);
    expect(isIpSafe('64:ff9b::169.254.169.254').safe).toBe(false);
    expect(isIpSafe('64:ff9b::10.0.0.1').safe).toBe(false);
    expect(isIpSafe('64:ff9b::192.168.1.1').safe).toBe(false);

    // IPv4-mapped safe IP
    expect(isIpSafe('::ffff:8.8.8.8').safe).toBe(true);
    expect(isIpSafe('64:ff9b::1.1.1.1').safe).toBe(true);
  });

  it('handles invalid IP formats gracefully', () => {
    expect(isIpSafe('abc').safe).toBe(false);
    expect(isIpSafe('999.999.999.999').safe).toBe(false);
    expect(isIpSafe('::ffff:1.2.3.abc').safe).toBe(false);
    expect(isIpSafe('012.0.0.1').safe).toBe(false);
  });

  it('rejects ambiguous leading-zero octal IPv4 literals in URLs', async () => {
    // Leading-zero octets like 012.0.0.1 resolve via DNS to internal IPs like 10.0.0.1
    expect((await isUrlSafe('http://012.0.0.1')).safe).toBe(false);
    expect((await isUrlSafe('http://0177.0.0.1')).safe).toBe(false);
  });
});

describe('isUrlSafe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('allows http and https only', async () => {
    expect((await isUrlSafe('http://google.com')).safe).toBe(true);
    expect((await isUrlSafe('https://google.com')).safe).toBe(true);
    expect((await isUrlSafe('ftp://google.com')).safe).toBe(false);
    expect((await isUrlSafe('gopher://google.com')).safe).toBe(false);
    expect((await isUrlSafe('file:///etc/passwd')).safe).toBe(false);
  });

  it('handles invalid URL format', async () => {
    expect((await isUrlSafe('not-a-url')).safe).toBe(false);
  });

  it('enforces safety on raw IP literal URLs directly', async () => {
    expect((await isUrlSafe('http://127.0.0.1')).safe).toBe(false);
    expect((await isUrlSafe('https://169.254.169.254/metadata')).safe).toBe(false);
    expect((await isUrlSafe('http://[::1]')).safe).toBe(false);
    expect((await isUrlSafe('http://[::ffff:169.254.169.254]')).safe).toBe(false);
    expect((await isUrlSafe('http://8.8.8.8')).safe).toBe(true);
  });

  it('resolves hostname and blocks if any resolved address is unsafe', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as any;

    // Safe resolution
    lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    expect((await isUrlSafe('http://example.com')).safe).toBe(true);

    // Unsafe resolution
    lookupSpy.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    expect((await isUrlSafe('http://example.com')).safe).toBe(false);

    // Multiple addresses, one is unsafe
    lookupSpy.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ]);
    expect((await isUrlSafe('http://example.com')).safe).toBe(false);
  });

  it('treats DNS failure as unsafe (fail closed)', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as any;
    lookupSpy.mockRejectedValue(new Error('ENOTFOUND'));

    expect((await isUrlSafe('http://non-existent-domain.fake')).safe).toBe(false);
  });

  it('treats empty DNS records as unsafe', async () => {
    const lookupSpy = vi.spyOn(dns.promises, 'lookup') as any;
    lookupSpy.mockResolvedValue([]);

    expect((await isUrlSafe('http://empty-dns.com')).safe).toBe(false);
  });
});

describe('safeFetch', () => {
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    originalFetch = global.fetch;
    global.fetch = mockFetch;

    // Default mock DNS behavior for domain names in tests
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async (hostname: string) => {
      if (hostname === 'safe.com' || hostname === 'safe-redirect.com') {
        return [{ address: '1.1.1.1', family: 4 }];
      }
      if (hostname === 'unsafe.com') {
        return [{ address: '10.0.0.1', family: 4 }];
      }
      throw new Error('DNS lookup failed in mock');
    }) as any);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('successfully fetches a safe URL', async () => {
    const mockResponse = new Response('OK', { status: 200 });
    mockFetch.mockResolvedValue(mockResponse);

    const response = await safeFetch('http://safe.com');
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith('http://safe.com', { redirect: 'manual' });
  });

  it('rejects fetch of an unsafe URL immediately without calling fetch', async () => {
    await expect(safeFetch('http://unsafe.com')).rejects.toThrow('blocked: destination not allowed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('follows a safe redirect to completion', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'http://safe-redirect.com/target' }
      }))
      .mockResolvedValueOnce(new Response('Final Content', { status: 200 }));

    const response = await safeFetch('http://safe.com');
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://safe.com', { redirect: 'manual' });
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://safe-redirect.com/target', { redirect: 'manual' });
  });

  it('resolves relative redirects correctly and safely', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('', {
        status: 301,
        headers: { Location: '/relative-path?q=1' }
      }))
      .mockResolvedValueOnce(new Response('Path Content', { status: 200 }));

    const response = await safeFetch('http://safe.com');
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, 'http://safe.com', { redirect: 'manual' });
    expect(mockFetch).toHaveBeenNthCalledWith(2, 'http://safe.com/relative-path?q=1', { redirect: 'manual' });
  });

  it('blocks redirect chain if it leads to an unsafe URL', async () => {
    mockFetch.mockResolvedValueOnce(new Response('', {
      status: 302,
      headers: { Location: 'http://unsafe.com/secrets' }
    }));

    await expect(safeFetch('http://safe.com')).rejects.toThrow('blocked: destination not allowed');
    // Verify we only made the first call and did NOT proceed to the second
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('http://safe.com', { redirect: 'manual' });
  });

  it('rejects a redirect chain that exceeds maxRedirects', async () => {
    mockFetch.mockResolvedValue(new Response('', {
      status: 302,
      headers: { Location: 'http://safe.com' }
    }));

    await expect(safeFetch('http://safe.com', {}, 3)).rejects.toThrow('Max redirects exceeded');
    expect(mockFetch).toHaveBeenCalledTimes(4); // initial + 3 redirect attempts
  });
});
