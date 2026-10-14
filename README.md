# Scroll Screenshot

A modern, high-precision Chrome Extension (Manifest V3) that automatically captures consecutive visible viewports, scrolls down the page, and saves all captured screenshots directly to your `~/Downloads/` directory in one batch.

---

## ✨ Features

- **Automated Scrolling Loop**: Captures visible screen area $\to$ buffers in memory $\to$ scrolls down $\to$ repeats until the bottom of the page is reached.
- **Smart Container & Layer Detection**:
  - Automatically identifies whether scrolling belongs to the window or a nested scrollable container (e.g., side drawers, comment panels, or modal dialogs).
  - Designed to intelligently target complex layouts (such as Douyin/TikTok comment panels) rather than triggering background video switches.
- **Batch Export (No Spam Dialogs)**:
  - Screenshots are buffered in memory during the capture process without triggering repeated download popups.
  - Generates a single `.zip` file archive (or batch image sequence) on completion.
- **Clean Native Rendering**: Does not attach invasive debuggers or trigger viewport resize banners. 100% preserves original layout and pixel ratio.
- **Zero External Dependencies**: Pure JavaScript, lightweight, privacy-focused (all operations happen locally on your machine).
- **Internationalization (i18n)**:
  - Default: **English**
  - Fallback: **Chinese (`zh_CN`)** when system language is Chinese.

---

## 🚀 Installation

1. Clone or download this repository:
   ```bash
   git clone https://github.com/your-username/scroll-screenshot.git
   ```
2. Open Google Chrome and navigate to:
   ```
   chrome://extensions
   ```
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the extension folder (`chrome_extension`).

---

## 📖 How to Use

1. Navigate to the webpage you want to capture.
2. Click the **Scroll Screenshot** extension icon in your toolbar (or press <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>).
3. (Optional) Adjust your settings in the popup:
   - **Delay after scroll**: Delay in milliseconds to wait for lazy-loaded images or DOM rendering (default: `1000ms`).
   - **Max shots**: Maximum number of viewports to capture (`0` = unlimited until the page bottom).
   - **Overlap**: Pixel overlap between adjacent screenshots to prevent missing split text lines.
   - **Format**: `PNG` or `JPEG`.
   - **Save Method**: `Pack into a single ZIP file` (default) or `Save as individual images`.
   - **Subfolder**: Optional subfolder under your `~/Downloads/` directory.
   - **Scroll to top before starting**: Start capturing from the beginning of the page.
4. Click **Start Capture** (or press <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd>).
5. The extension will automatically scroll and capture. Click **Stop & Save** at any time to finish early and save whatever has been captured so far.

---

## ⚙️ Chrome Download Settings Tip

If you choose to export individual images and Chrome keeps prompting you with a "Save As" file dialog for each screenshot:
1. Go to `chrome://settings/downloads`.
2. Disable **"Ask where to save each file before downloading"**.

*(When exporting as a ZIP file, only a single prompt will appear at most).*

---

## 📁 Project Structure

```text
├── manifest.json         # Manifest V3 configuration & permissions
├── background.js        # Background service worker (capture & scroll logic)
├── popup.html           # Popup settings interface
├── popup.js             # Popup controls & options persistence
├── popup.css            # Clean modern styling
├── offscreen.html       # Offscreen document host
├── offscreen.js         # Zero-dependency in-memory ZIP packager & Blob builder
└── _locales/
    ├── en/messages.json # English translations (default)
    ├── zh/messages.json # Chinese translations
    └── zh_CN/messages.json
```

---

## 🔒 Privacy & Permissions

- `scripting` & `host_permissions (<all_urls>)`: Required to scroll the target page and determine content boundaries.
- `downloads`: Required to save screenshots to your Downloads folder.
- `storage`: Preserves user preferences across sessions.
- `tabs`: Queries the active tab and captures visible viewports.
- `offscreen`: Converts screenshots into an in-memory zip archive without blocking extension service workers.

**No tracking. No analytics. No external network requests.**

---

## 📄 License

[MIT License](LICENSE)
