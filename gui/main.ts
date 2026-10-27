// Every window loads the one page (index.html); ?view= says which window it is (the main
// process opens it so). That view's module brings its own markup, styles and code, and only
// it is loaded: the notebook never fetches the 3D office.
import './ipc/host'; // (the mouse and dropped files, for every window)
import './ui/theme';

const VIEWS: Record<string, () => Promise<unknown>> = {
  appview: () => import('./views/appview/appview'),
  card: () => import('./views/card/card'),
  drone: () => import('./views/drone/drone'),
  groupchat: () => import('./views/groupchat/groupchat'),
  island: () => import('./views/island/island'),
  manager: () => import('./views/manager/manager'),
  meeting: () => import('./views/meeting/meeting'),
  notebook: () => import('./views/notebook/notebook'),
  palette: () => import('./views/palette/palette'),
  plane: () => import('./views/plane/plane'),
  quick: () => import('./views/quick/quick'),
  robot: () => import('./views/robot/robot'),
  snip: () => import('./views/snip/snip'),
  stage: () => import('./views/stage/stage'),
  walker: () => import('./views/walker/walker'),
  words: () => import('./views/words/words'),
};

const view = new URLSearchParams(location.search).get('view') ?? '';
if (view in VIEWS) VIEWS[view]();
else console.error(`No view called "${view}"`);
