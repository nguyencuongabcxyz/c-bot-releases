// Puts a view's page in place: its markup (a fragment: the views share index.html), the
// window's title and the classes its <body> starts with, then its [data-icon] icons, now
// and again once the view's own code has run (it may have added some).
import { Icon } from './icons';

export function showView(markup: string, { title, bodyClass = '' }: { title: string; bodyClass?: string }) {
  document.title = title;
  document.body.className = bodyClass;
  document.body.innerHTML = markup;
  Icon.fill();
  setTimeout(() => Icon.fill());
}
