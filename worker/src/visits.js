/**
 * Counting visits, and nothing else.
 *
 * Each page load adds one to that day's total. No IP address, browser details,
 * referrer, cookie or id is read or kept, so the count cannot tell one visitor
 * from another - it is a tally of page loads, not of people.
 *
 * Totals live in D1 (schema/visits.sql). On the free plan D1 refuses writes
 * past its daily limit rather than billing, and a count that fails is simply
 * lost: the page never waits for, or learns about, the answer.
 */

export async function countVisit(db, day) {
  if (!db) return;
  try {
    await db
      .prepare('INSERT INTO visits (day, count) VALUES (?1, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1')
      .bind(day)
      .run();
  } catch (error) {
    console.error(error);
  }
}
