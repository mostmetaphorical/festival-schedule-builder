/**
 * Bug reports from the app.
 *
 * A report is short free text plus a few optional facts the person chose to
 * include. Like everything else here it is rebuilt from checked values rather
 * than stored as sent, so an unexpected field - or a whole rating history
 * pasted into a hidden one - never reaches storage.
 *
 * Reports are read by the maintainer with wrangler, as plain text, never
 * rendered in a browser.
 */

import { RejectedUpload } from './ratings.js';

export const REPORT_LIMITS = {
  minMessage: 10,
  maxMessage: 3000,
  maxContact: 200,
  maxDetail: 300,
};

export const REPORT_STEPS = ['ratings', 'festival', 'your-time', 'plan', 'other'];

// Everything a report may say about the device it came from, if the person
// ticked the box. Short strings only.
const DETAIL_FIELDS = ['browser', 'screen', 'festival', 'films', 'page', 'version'];

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,180}\.[^\s@<>"]{2,}$/;

function clean(value, field, max) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new RejectedUpload(`${field} must be text.`);
  const text = value.trim();
  if (CONTROL.test(text)) throw new RejectedUpload(`${field} contains characters that aren't allowed.`);
  if (text.length > max) throw new RejectedUpload(`${field} is longer than ${max} characters.`);
  return text || undefined;
}

/** Check a report and return a rebuilt copy holding only known fields. */
export function validateReport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RejectedUpload('A report must be a JSON object.');
  }

  const message = clean(data.message, 'The description', REPORT_LIMITS.maxMessage);
  if (!message || message.length < REPORT_LIMITS.minMessage) {
    throw new RejectedUpload('Please describe what went wrong in a sentence or two.');
  }

  const step = REPORT_STEPS.includes(data.step) ? data.step : 'other';

  const contact = clean(data.contact, 'The email address', REPORT_LIMITS.maxContact);
  if (contact && !EMAIL.test(contact)) {
    throw new RejectedUpload("That email address doesn't look right. Leave it empty if you'd rather not give one.");
  }

  let details;
  if (data.details !== undefined && data.details !== null) {
    if (typeof data.details !== 'object' || Array.isArray(data.details)) {
      throw new RejectedUpload('Details must be an object.');
    }
    details = {};
    for (const field of DETAIL_FIELDS) {
      const value = clean(data.details[field], `The ${field} detail`, REPORT_LIMITS.maxDetail);
      if (value) details[field] = value;
    }
  }

  return Object.fromEntries(
    Object.entries({ message, step, contact, details }).filter(([, value]) => value !== undefined)
  );
}
