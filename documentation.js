// Author: Jiajun (Carson) Chen
// email: jic4015@med.cornell.edu
/**
 * @fileoverview Progressive enhancement of the separate research documentation page.
 * Both documents remain readable without JavaScript. Fragment links select a
 * document and preserve deep links to individual method/field sections.
 */
// Local, double-click previews return to the self-contained dashboard snapshot.
if (location.protocol === 'file:') {
  for (const link of document.querySelectorAll('a[href^="./index.html"]')) {
    link.setAttribute(
      'href',
      link.getAttribute('href').replace('./index.html', './preview.html'),
    );
  }
}
// Each document remains readable when JavaScript is disabled. With JavaScript,
// hash links select the requested document and preserve shareable section links.
document.body.classList.add('documentation-enhanced');
const documents = [...document.querySelectorAll('.research-document')];
const links = [...document.querySelectorAll('[data-document]')];
/**
 * Selects the document containing the URL fragment and updates its tab state.
 * Malformed URL escapes fall back to the first document. Scrolling is deferred
 * until hidden sections are updated, so deep links land on visible headings.
 */
function showDocument() {
  let fragment = '';
  try {
    fragment = decodeURIComponent(location.hash.slice(1));
  } catch {}
  const target = document.getElementById(fragment);
  const active =
    target?.closest('.research-document') ||
    documents.find((doc) => fragment.startsWith(doc.id)) ||
    documents[0];
  for (const doc of documents) {
    doc.hidden = doc !== active;
  }
  for (const link of links) {
    const selected = link.dataset.document === active.id;
    if (selected) {
      link.setAttribute('aria-current', 'true');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  document.title = `${active.querySelector('.document-heading h2').textContent} — Weill Cornell Medicine Telehealth Insights`;
  if (target && target !== active) {
    requestAnimationFrame(() =>
      target.scrollIntoView({block: 'start', behavior: 'instant'}),
    );
  }
  if (target === active) {
    requestAnimationFrame(() =>
      document
        .querySelector('.document-switcher')
        .scrollIntoView({block: 'start', behavior: 'instant'}),
    );
  }
}
window.addEventListener('hashchange', showDocument);
showDocument();
