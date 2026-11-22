// House rules for project-authored files in the repository.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Official licence texts and third-party notices are reproduced verbatim and are exempt.
const VERBATIM = new Set(['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'package-lock.json']);

function projectFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return out.split('\n').filter((f) => f && !VERBATIM.has(f) && !/\.(woff2|png|webp|ico)$/.test(f));
}

describe('house rules', () => {
  const files = projectFiles();

  it('finds the project files through git', () => {
    expect(files).toContain('README.md');
    expect(files).toContain('registry/sources.json');
  });

  it('uses no em or en dashes in any project-authored file', () => {
    const dash = new RegExp('[' + String.fromCharCode(0x2013) + String.fromCharCode(0x2014) + ']');
    expect(files.filter((f) => dash.test(readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('commits no Markdown other than README.md and CHANGELOG.md, and nothing from local/', () => {
    expect(files.filter((f) => /\.md$/i.test(f) && f !== 'README.md' && f !== 'CHANGELOG.md')).toEqual([]);
    expect(files.filter((f) => f.startsWith('local/'))).toEqual([]);
  });

  it('carries no private paths and no personal email addresses', () => {
    const leaks = /(?<![A-Za-z])[A-Za-z]:[\\/](?!\/)|C:\\Users|tattersgaming|dostrom/;
    expect(files.filter((f) => !f.startsWith('tests/unit/house.test.ts') && leaks.test(readFileSync(f, 'utf8')))).toEqual([]);
  });
});
