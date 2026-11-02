import { describe, expect, it } from 'vitest';
import {
  BusinessProfile,
  BusinessProfileDraft,
  REQUIRED_PROFILE_FIELDS,
  missingRequiredProfileFields,
} from './business-profile.js';

const required = {
  name: 'פרחי השרון',
  field: 'Flower shop',
  mainProducts: ['Bouquets', 'Potted plants'],
  location: { city: 'Kfar Saba', address: 'Weizmann 10', hours: 'Sun-Thu 9-19', fulfillment: ['pickup'] },
  targetAudience: 'Local residents',
  differentiator: 'Fresh flowers every morning',
  channels: ['instagram'],
  style: 'warm',
  approverPhone: '+972501234567',
} as const;

describe('BusinessProfile', () => {
  it('applies PRD defaults to missing optional fields', () => {
    const profile = BusinessProfile.parse(required);
    expect(profile.languages).toEqual(['he']);
    expect(profile.tone).toEqual({ register: 'warm', address: 'plural', emoji: true });
    expect(profile.contentTypes).toEqual(['products', 'promotions']);
    expect(profile.formats).toEqual(['single']);
    expect(profile.postsPerWeek).toBe(3);
    expect(profile.schedule.publishOnShabbatAndHolidays).toBe(false);
    expect(profile.callToAction).toBe('visit');
    expect(profile.forbiddenTopics).toEqual(['politics', 'competitor comparisons']);
    expect(profile.fixedHashtags).toEqual([]);
  });

  it('defaults the target audience to local residents', () => {
    const { targetAudience: _omit, ...rest } = required;
    expect(BusinessProfile.parse(rest).targetAudience).toBe('Local residents');
  });

  it.each([1, 6, 2.5])('rejects %s posts per week', (postsPerWeek) => {
    expect(BusinessProfile.safeParse({ ...required, postsPerWeek }).success).toBe(false);
  });

  it('requires at least one channel', () => {
    expect(BusinessProfile.safeParse({ ...required, channels: [] }).success).toBe(false);
  });

  it('rejects a duplicated channel', () => {
    expect(BusinessProfile.safeParse({ ...required, channels: ['instagram', 'instagram'] }).success).toBe(false);
  });

  it('requires an E.164 approver phone', () => {
    expect(BusinessProfile.safeParse({ ...required, approverPhone: '050-1234567' }).success).toBe(false);
  });

  it('rejects a style outside the three styles', () => {
    expect(BusinessProfile.safeParse({ ...required, style: 'retro' }).success).toBe(false);
  });

  it('rejects publishing hours that are not HH:MM', () => {
    const schedule = { publishOnShabbatAndHolidays: false, days: [0], hours: ['9am'] };
    expect(BusinessProfile.safeParse({ ...required, schedule }).success).toBe(false);
  });

  it('rejects brand colors that are not hex', () => {
    expect(BusinessProfile.safeParse({ ...required, brand: { colors: ['red'] } }).success).toBe(false);
  });
});

describe('BusinessProfileDraft', () => {
  it('accepts an empty draft', () => {
    expect(BusinessProfileDraft.parse({})).toEqual({});
  });

  it('still validates the fields that are present', () => {
    expect(BusinessProfileDraft.safeParse({ postsPerWeek: 9 }).success).toBe(false);
  });
});

describe('missingRequiredProfileFields', () => {
  it('lists every required field without a default for an empty draft', () => {
    expect(missingRequiredProfileFields({}).sort()).toEqual(
      ['name', 'field', 'mainProducts', 'location', 'differentiator', 'channels', 'style', 'approverPhone'].sort(),
    );
  });

  it('returns nothing for a complete draft', () => {
    expect(missingRequiredProfileFields(required)).toEqual([]);
  });

  it('treats empty arrays and blank strings as missing', () => {
    expect(missingRequiredProfileFields({ ...required, channels: [], name: '  ' }).sort()).toEqual(['channels', 'name']);
  });

  it('only checks fields from the required list', () => {
    expect(REQUIRED_PROFILE_FIELDS).not.toContain('postsPerWeek');
  });
});
