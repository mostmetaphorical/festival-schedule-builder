/**
 * The contact address, kept out of the page's text.
 *
 * Address harvesters mostly read raw HTML and scripts looking for the pattern
 * name@domain. So the address is stored in pieces, in a different order, and
 * only put together in the browser when someone actually asks to email - by
 * opening the emailing instructions or the bug report form.
 */

const PARTS = ['net', 'passmail', 'crucial122', 'festrecommender'];

export function contactAddress() {
  const [tld, domain, tag, name] = PARTS;
  return `${name}.${tag}${String.fromCharCode(64)}${domain}.${tld}`;
}

export function mailto({ subject = '', body = '' } = {}) {
  const query = new URLSearchParams();
  if (subject) query.set('subject', subject);
  if (body) query.set('body', body);
  // URLSearchParams writes spaces as "+", which mail apps show literally.
  const text = query.toString().replace(/\+/g, '%20');
  return `mailto:${contactAddress()}${text ? `?${text}` : ''}`;
}

/** Fill every [data-contact] link inside `root` with the address. */
export function revealContact(root = document) {
  root.querySelectorAll('[data-contact]').forEach((link) => {
    link.href = mailto({ subject: link.dataset.subject || '' });
    link.textContent = contactAddress();
  });
}
