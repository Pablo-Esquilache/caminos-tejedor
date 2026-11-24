import { describe, expect, it } from 'vitest';
import { escapeHtml } from './htmlEscape';

describe('escapeHtml', () => {
  it('escapa todos los caracteres peligrosos (&, <, >, ", \')', () => {
    expect(escapeHtml(`A & B <tag attr="x" single='y'>`)).toBe(
      'A &amp; B &lt;tag attr=&quot;x&quot; single=&#39;y&#39;&gt;'
    );
  });

  it('neutraliza payload XSS con <img src=x onerror=alert(1)> sin dejar un <img real', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = `<strong>Reclamo: ${escapeHtml(payload)}</strong>`;

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('convierte null, undefined y números de forma segura con String()', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml('Camino Real — Tramo Norte')).toBe('Camino Real — Tramo Norte');
  });
});
