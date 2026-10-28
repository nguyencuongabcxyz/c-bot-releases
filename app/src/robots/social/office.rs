//! Office life, once a day each on workdays at the right time: a lunch order, lunch out together, a milk-tea round desk to desk.

use super::*;

pub(super) fn try_scene(app: &AppHandle) -> bool {
    if visit(app).is_some() {
        return false;
    }
    let now = Local::now();
    let settings = with(app, |st| st.store.settings().clone());
    if !workdays(&settings).contains(&now.weekday().num_days_from_sunday()) {
        return false;
    }
    let mins = now.hour() * 60 + now.minute();
    let day = today();
    let (lunch_day, tea_day) = soc(app, |s| (s.lunch_day.clone(), s.tea_day.clone()));
    let ids = live(app);
    let organisers: Vec<&String> = ids
        .iter()
        .filter(|id| {
            free_awake(app, id)
                && rep(app, id).idle_ms() >= 45_000.0
                && rep(app, id).wanders()
                && !in_visit(app, id)
        })
        .collect();
    for a in organisers {
        if random() > 0.06 * kk(app) {
            continue;
        }
        if lunch_day != day && (within(mins, SCENE_ORDER) || within(mins, SCENE_GOOUT)) {
            let out = within(mins, SCENE_GOOUT);
            let hosts: Vec<&String> = ids
                .iter()
                .filter(|b| {
                    *b != a
                        && free_awake(app, b)
                        && !in_visit(app, b)
                        && same_screen(app, a, b)
                        && (!out || rep(app, b).wanders())
                })
                .collect();
            if let Some(b) = pick(&hosts) {
                return scene(
                    app,
                    if out { Mode::GoOut } else { Mode::Order },
                    a,
                    b,
                    vec![],
                );
            }
        }
        if tea_day != day && within(mins, SCENE_TEA) {
            // everyone at a desk on this screen, nearest first (the busy ones get the usual)
            let mut stops: Vec<String> = ids
                .iter()
                .filter(|b| {
                    *b != a
                        && at_desk(app, b)
                        && !rep(app, b).b("chat")
                        && rep(app, b).b("awake")
                        && same_screen(app, a, b)
                })
                .cloned()
                .collect();
            stops.sort_by(|x, y| dist(app, a, x).total_cmp(&dist(app, a, y)));
            if !stops.is_empty() {
                let first = stops.remove(0);
                return scene(app, Mode::Tea, a, &first, stops);
            }
        }
    }
    false
}

/// An office scene: Order, GoOut or Tea (a goes to b; tea: then the stops).
pub fn scene(app: &AppHandle, kind: Mode, a: &str, b: &str, stops: Vec<String>) -> bool {
    soc(app, |s| {
        if kind == Mode::Tea {
            s.tea_day = today()
        } else {
            s.lunch_day = today()
        }
    });
    start(app, a, b, kind, stops, None)
}
