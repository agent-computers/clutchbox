import { COMPUTER_SIZE_NAMES, COMPUTER_SIZES, type ComputerSize } from '@agent-computers/computer';
import { type BuildOptions, Template, waitForURL } from 'e2b';
import { HELPER_DIR, REVISION, REVISION_FILE, TEMPLATE, templateFor, writeHelpers } from './index';

// The E2B template computers start from: E2B Desktop plus current Chrome, Node for the helpers, and the helpers
// themselves. Its snapshot already runs the desktop and Chrome, so a new computer is ready when create returns.
export const computerTemplate = () =>
  Template()
    .fromTemplate('desktop')
    .setUser('root')
    .runCmd([
      // Current Chrome (sites may reject outdated browsers) and CJK fonts for real pages.
      'curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb && apt-get update && apt-get install -y /tmp/chrome.deb fonts-noto-cjk && rm /tmp/chrome.deb && rm -rf /var/lib/apt/lists/*',
      'curl -fsSL https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz -o /tmp/node.tar.xz && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && rm /tmp/node.tar.xz',
      `mkdir -p ${HELPER_DIR}`,
      writeHelpers(),
      // Computers from this build start on REVISION, so their first open skips the refresh's restart.
      `echo ${REVISION} > ${REVISION_FILE}`,
      'node --version && google-chrome --version && command -v curl',
      // Chrome runs sandboxed (no --no-sandbox): without user namespaces it needs this setuid helper.
      'test "$(stat -c %U:%a /opt/google/chrome/chrome-sandbox)" = root:4755',
    ])
    .setUser('user')
    .setStartCmd(`${HELPER_DIR}/start-desktop.sh`, waitForURL('http://127.0.0.1:9222/json/version'));

// Builds the template into the E2B team of E2B_API_KEY, under `name`, once for each size (COMPUTER_SIZES), since E2B
// fixes a computer's CPUs and memory at build. The sizes share the recipe, so builds after the first reuse its layers.
export async function buildComputerTemplate(
  name = process.env.E2B_COMPUTER_TEMPLATE || TEMPLATE,
  options: Pick<BuildOptions, 'onBuildLogs'> = {},
  sizes: readonly ComputerSize[] = COMPUTER_SIZE_NAMES,
) {
  const built = [];
  for (const size of sizes) {
    const { cpuCount, memoryMB } = COMPUTER_SIZES[size];
    const info = await Template.build(computerTemplate(), templateFor(name, size), { cpuCount, memoryMB, ...options });
    built.push({
      size,
      template: info.name ?? templateFor(name, size),
      templateId: info.templateId,
      buildId: info.buildId,
    });
  }
  return built;
}
