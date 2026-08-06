import { PageTransition, Panel } from '../components/ui.jsx';
import './extensions.css';

export default function Extensions() {
  return (
    <PageTransition>
      <Panel title="Opptra Connector Capture">
        <p className="lead">
          Records a real Unicommerce browsing session so the platform can learn the endpoints
          a channel uses. Install it once, then run a capture whenever a connector needs
          re-teaching.
        </p>

        <a className="btn btn-primary ext-dl" href="/downloads/opptra-session-helper.zip" download>
          ↓ Download Connector Capture (.zip)
        </a>

        <ol className="steps">
          <li>Unzip the download into a folder you will keep — Chrome loads the extension from that folder every time it starts.</li>
          <li>Open <code>chrome://extensions</code> in Chrome.</li>
          <li>Enable <b>Developer mode</b> (top right).</li>
          <li>Click <b>Load unpacked</b> and select the unzipped folder.</li>
          <li>Open the extension and paste this platform&rsquo;s URL plus an access token from <b>Admin → Access tokens</b>.</li>
          <li>Pick the channel you are about to capture.</li>
          <li>Click <b>Start</b>.</li>
          <li>Log in to Unicommerce as you normally would.</li>
          <li>Click through <b>Orders</b>, <b>Inventory</b> and open <b>one shipment</b> — that is the minimum the capture needs.</li>
          <li>Click <b>Stop</b>. The capture uploads itself; nothing else to do.</li>
        </ol>
      </Panel>

      <Panel title="Bulk Invoice & E-way Downloader">
        <p className="lead">
          Downloads every invoice and e-way bill PDF on a Unicommerce list page in one pass,
          instead of one click per document.
        </p>

        <a className="btn btn-primary ext-dl" href="/downloads/bulk-download-extension.zip" download>
          ↓ Download Bulk Downloader (.zip)
        </a>

        <ol className="steps">
          <li>Unzip the download into a folder you will keep.</li>
          <li>Open <code>chrome://extensions</code> in Chrome.</li>
          <li>Enable <b>Developer mode</b>, then click <b>Load unpacked</b> and select the unzipped folder.</li>
          <li>Open Unicommerce and sign in.</li>
          <li>Go to the invoice list and filter it down to exactly what you want.</li>
          <li>Click the extension — it downloads all the PDFs on that list to your Downloads folder.</li>
        </ol>
      </Panel>
    </PageTransition>
  );
}
