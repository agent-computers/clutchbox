import { describe, expect, it } from 'vitest';
import { serverOrigin } from './server';

describe('serverOrigin', () => {
  it('keeps only the origin', () => {
    expect(serverOrigin('https://clutchbox.example.com/app?x=1&y=2#z')).toBe('https://clutchbox.example.com');
  });

  it('allows plain HTTP only on this machine', () => {
    expect(serverOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(serverOrigin('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(() => serverOrigin('http://clutchbox.example.com')).toThrow('https');
  });

  it('refuses what is not an HTTPS URL', () => {
    expect(() => serverOrigin('clutchbox.example.com & calc')).toThrow('must be a URL');
    expect(() => serverOrigin('file:///etc/passwd')).toThrow('https');
    expect(() => serverOrigin('https://user:pass@clutchbox.example.com')).toThrow('username');
  });
});
