use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl, WebviewWindowBuilder, http};
use tauri_plugin_opener::OpenerExt;

/// The splash page is embedded in the binary and served from its own `splash:` protocol,
/// so it shows instantly and needs nothing from the Angular build.
const SPLASH_HTML: &str = include_str!("../splash/index.html");

// Custom protocols are exposed as `http://<scheme>.localhost` on Windows and Android.
#[cfg(any(windows, target_os = "android"))]
const SPLASH_URL: &str = "http://splash.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const SPLASH_URL: &str = "splash://localhost/";

static WINDOW_COUNTER: AtomicUsize = AtomicUsize::new(0);

/// Whether `url` belongs to the app itself (the bundled frontend, or `ng serve` in dev).
fn is_app_url<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
  if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
    return true;
  }
  cfg!(dev)
    && app
      .config()
      .build
      .dev_url
      .as_ref()
      .is_some_and(|dev| dev.origin() == url.origin())
}

/// Hands a link the webview should not open itself to the operating system (default browser,
/// mail client, ...). Only schemes a browser tab would open are passed on.
fn open_externally<R: Runtime>(app: &AppHandle<R>, url: &Url) {
  if matches!(url.scheme(), "http" | "https" | "mailto") {
    if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
      log::warn!("could not open {url}: {err}");
    }
  }
}

/// Webviews block `window.open` and `target="_blank"` by default. App pages (the presenter view)
/// get their own window; everything else, including top-level navigation away from the app,
/// goes to the system browser so the app window is never replaced by a website.
fn with_link_handling<'a, R: Runtime, M: Manager<R>>(
  builder: WebviewWindowBuilder<'a, R, M>,
  app: AppHandle<R>,
) -> WebviewWindowBuilder<'a, R, M> {
  let nav_app = app.clone();
  builder
    .on_navigation(move |url| {
      if is_app_url(&nav_app, url) || matches!(url.scheme(), "about" | "blob" | "data") {
        true
      } else {
        open_externally(&nav_app, url);
        false
      }
    })
    .on_new_window(move |url, features| {
      if !is_app_url(&app, &url) {
        open_externally(&app, &url);
        return NewWindowResponse::Deny;
      }
      let label = format!("window-{}", WINDOW_COUNTER.fetch_add(1, Ordering::Relaxed));
      let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::External("about:blank".parse().unwrap()))
        .title("Decktech")
        .inner_size(1280.0, 800.0)
        .window_features(features)
        .on_document_title_changed(|window, title| {
          let _ = window.set_title(&title);
        });
      match with_link_handling(builder, app.clone()).build() {
        Ok(window) => NewWindowResponse::Create { window },
        Err(err) => {
          log::warn!("could not open window for {url}: {err}");
          NewWindowResponse::Deny
        }
      }
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .register_uri_scheme_protocol("splash", |_ctx, _request| {
      http::Response::builder()
        .header(http::header::CONTENT_TYPE, "text/html; charset=utf-8")
        .body(SPLASH_HTML.as_bytes())
        .expect("valid splash response")
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      WebviewWindowBuilder::new(app, "splash", WebviewUrl::External(SPLASH_URL.parse()?))
        .title("Decktech")
        .inner_size(480.0, 300.0)
        .center()
        .resizable(false)
        .decorations(false)
        .skip_taskbar(true)
        .build()?;

      // The main window is declared in tauri.conf.json (hidden, `create: false`) and only
      // shown once the app has loaded, at which point the splash goes away.
      let main_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .expect("main window in tauri.conf.json")
        .clone();
      let main = WebviewWindowBuilder::from_config(app, &main_config)?.on_page_load(|window, payload| {
        if payload.event() == PageLoadEvent::Finished {
          if let Some(splash) = window.get_webview_window("splash") {
            let _ = splash.close();
          }
          let _ = window.show();
          let _ = window.set_focus();
        }
      });
      with_link_handling(main, app.handle().clone()).build()?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
