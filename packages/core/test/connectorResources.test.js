import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleResourceRef } from '../src/connectorResources.js';

describe('parseGoogleResourceRef', () => {
  it('parses spreadsheet URLs', () => {
    const r = parseGoogleResourceRef('https://docs.google.com/spreadsheets/d/1AbC_def-GHI1234567890/edit#gid=0');
    assert.equal(r.kind, 'spreadsheet');
    assert.equal(r.externalId, '1AbC_def-GHI1234567890');
  });

  it('parses folder URLs', () => {
    const r = parseGoogleResourceRef('https://drive.google.com/drive/folders/0Bxxxxxxxxxxxxxxxxxxxx');
    assert.equal(r.kind, 'drive_folder');
    assert.equal(r.externalId, '0Bxxxxxxxxxxxxxxxxxxxx');
  });

  it('parses file URLs', () => {
    const r = parseGoogleResourceRef('https://drive.google.com/file/d/1fileIdXXXXXXXXXXXX/view');
    assert.equal(r.kind, 'drive_file');
    assert.equal(r.externalId, '1fileIdXXXXXXXXXXXX');
  });

  it('uses preferredKind for raw ids', () => {
    const r = parseGoogleResourceRef('1AbC_def-GHI1234567890xyz', 'spreadsheet');
    assert.equal(r.kind, 'spreadsheet');
    assert.equal(r.externalId, '1AbC_def-GHI1234567890xyz');
  });

  it('rejects junk', () => {
    assert.equal(parseGoogleResourceRef(''), null);
    assert.equal(parseGoogleResourceRef('not a link'), null);
  });
});
