import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateReport } from '../src/report.js';

const rejects = (data, pattern) =>
  assert.throws(() => validateReport(data), (error) => pattern.test(error.message));

test('a report keeps only known fields', () => {
  const report = validateReport({
    message: 'Dropping a film replaced it with another one.',
    step: 'plan',
    contact: 'someone@example.org',
    details: { browser: 'Firefox 130', screen: '390x844', ratings: 'Film A,2000,4\nFilm B,2001,5' },
    ratings: [{ title: 'A private film', rating: 5 }],
  });
  assert.deepEqual(report, {
    message: 'Dropping a film replaced it with another one.',
    step: 'plan',
    contact: 'someone@example.org',
    details: { browser: 'Firefox 130', screen: '390x844' },
  });
});

test('a report needs a real description', () => {
  rejects({ message: '' }, /describe/);
  rejects({ message: 'broken' }, /describe/);
  rejects({ message: 'x'.repeat(3001) }, /longer/);
});

test('control characters and odd types are refused', () => {
  rejects({ message: 'Something\u0000broke on the plan page' }, /aren't allowed/);
  rejects({ message: 12345678901 }, /text/);
  rejects({ message: 'The plan page did something odd', details: ['browser'] }, /object/);
  rejects('just a string', /object/);
});

test('an unknown step becomes "other"; a bad email is refused, an empty one dropped', () => {
  assert.equal(validateReport({ message: 'A thing went wrong here', step: 'admin' }).step, 'other');
  rejects({ message: 'A thing went wrong here', contact: 'not an email' }, /email/);
  assert.equal(validateReport({ message: 'A thing went wrong here', contact: '  ' }).contact, undefined);
});
