import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dir, "install.sh");
const REPO = "Endpoint-Esports-Ltd/sentinal";
const TAG = "v9.8.7";
const ASSET_NAME = "sentinal-darwin-arm64";
const BIN_BYTES = "#!/bin/sh\necho 'fake sentinal 9.8.7'\n";

const ASSETS: Array<{ id: number; name: string }> = [
  { id: 1001, name: "sentinal-darwin-x64" },
  { id: 1002, name: "sentinal-darwin-arm64" },
  { id: 1003, name: "sentinal-linux-x64" },
  { id: 1004, name: "sentinal-linux-arm64" },
  { id: 1005, name: "checksums.txt" },
];

const apiAssetUrl = (id: number): string =>
  `https://api.github.com/repos/${REPO}/releases/assets/${id}`;
const browserUrl = (name: string): string =>
  `https://github.com/${REPO}/releases/download/${TAG}/${name}`;

/** Pretty-printed like the real GitHub API: one key per line, nested uploader. */
function releaseJson(): string {
  const release = {
    url: `https://api.github.com/repos/${REPO}/releases/555`,
    id: 555,
    tag_name: TAG,
    name: TAG,
    assets: ASSETS.map((a) => ({
      url: apiAssetUrl(a.id),
      id: a.id,
      node_id: `RA_${a.id}`,
      name: a.name,
      label: "",
      uploader: {
        login: "github-actions[bot]",
        id: 41898282,
        url: "https://api.github.com/users/github-actions%5Bbot%5D",
      },
      content_type: "application/octet-stream",
      state: "uploaded",
      size: 1234,
      browser_download_url: browserUrl(a.name),
    })),
  };
  return JSON.stringify(release, null, 2);
}

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

function checksums(binaryHash: string): string {
  return (
    ASSETS.filter((a) => a.name !== "checksums.txt")
      .map((a) =>
        a.name === ASSET_NAME
          ? `${binaryHash}  ${a.name}`
          : `${sha256(a.name)}  ${a.name}`,
      )
      .join("\n") + "\n"
  );
}

const FAKE_CURL = `#!/bin/sh
# Hermetic fake curl for install.test.ts
for a in "$@"; do printf '%s\\n' "$a" >> "$FAKE_LOG"; done
printf '%s\\n' '---END---' >> "$FAKE_LOG"

OUT=""; URL=""; WFMT=""; FAIL=0; AUTH=0; OCTET=0
while [ $# -gt 0 ]; do
  case "$1" in
    -H)
      shift
      [ -z "$1" ] && { echo "fake curl: empty -H" >&2; exit 99; }
      case "$1" in
        Authorization:*) AUTH=1 ;;
        "Accept: application/octet-stream") OCTET=1 ;;
      esac ;;
    -o) shift; OUT="$1" ;;
    -w) shift; WFMT="$1" ;;
    -*)
      case "$1" in -*f*) FAIL=1 ;; esac ;;
    *) URL="$1" ;;
  esac
  shift
done

CODE=200; BODY=""
if [ "$AUTH" = 1 ] && [ "$FAKE_MODE" = "reject" ]; then
  CODE=401; BODY="$FAKE_DIR/unauthorized.json"
else
  case "$URL" in
    https://api.github.com/repos/${REPO}/releases/latest) BODY="$FAKE_DIR/release.json" ;;
    https://api.github.com/repos/${REPO}/releases/assets/1002)
      [ "$OCTET" = 1 ] && BODY="$FAKE_DIR/binary" || BODY="$FAKE_DIR/asset-meta.json" ;;
    https://api.github.com/repos/${REPO}/releases/assets/1005)
      [ "$OCTET" = 1 ] && BODY="$FAKE_DIR/checksums.txt" || BODY="$FAKE_DIR/asset-meta.json" ;;
    https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}) BODY="$FAKE_DIR/binary" ;;
    https://github.com/${REPO}/releases/download/${TAG}/checksums.txt) BODY="$FAKE_DIR/checksums.txt" ;;
    *) CODE=404; BODY="$FAKE_DIR/notfound.json" ;;
  esac
fi

if [ "$FAIL" = 1 ] && [ "$CODE" -ge 400 ]; then
  echo "curl: (22) The requested URL returned error: $CODE" >&2
  exit 22
fi
if [ -n "$OUT" ]; then cat "$BODY" > "$OUT"; else cat "$BODY"; fi
if [ -n "$WFMT" ]; then
  printf '%s' "$WFMT" | sed "s/%{http_code}/$CODE/"
fi
exit 0
`;

const FAKE_UNAME = `#!/bin/sh
case "$1" in
  -s) echo Darwin ;;
  -m) echo arm64 ;;
  *) echo Darwin ;;
esac
`;

let root: string;
let fakeBin: string;
let fakeDir: string;
let home: string;
let logPath: string;

function writeExec(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sentinal-install-test-"));
  fakeBin = join(root, "fakebin");
  fakeDir = join(root, "served");
  home = join(root, "home");
  logPath = join(root, "curl.log");
  for (const d of [fakeBin, fakeDir, home]) {
    spawnSync("mkdir", ["-p", d]);
  }
  writeExec(join(fakeBin, "curl"), FAKE_CURL);
  writeExec(join(fakeBin, "uname"), FAKE_UNAME);
  writeFileSync(join(fakeDir, "release.json"), releaseJson());
  writeFileSync(join(fakeDir, "binary"), BIN_BYTES);
  writeFileSync(join(fakeDir, "checksums.txt"), checksums(sha256(BIN_BYTES)));
  writeFileSync(
    join(fakeDir, "unauthorized.json"),
    '{"message":"Bad credentials"}',
  );
  writeFileSync(join(fakeDir, "notfound.json"), '{"message":"Not Found"}');
  writeFileSync(join(fakeDir, "asset-meta.json"), '{"id":1}');
  writeFileSync(logPath, "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(
  extraEnv: Record<string, string> = {},
  shell = "sh",
): ReturnType<typeof spawnSync> {
  return spawnSync(shell, [SCRIPT], {
    env: {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: home,
      SHELL: "/bin/zsh",
      FAKE_LOG: logPath,
      FAKE_DIR: fakeDir,
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 15_000,
  });
}

/** Each curl invocation's argv. */
function curlCalls(): string[][] {
  const calls: string[][] = [];
  let cur: string[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (line === "---END---") {
      calls.push(cur);
      cur = [];
    } else if (line !== "") {
      cur.push(line);
    }
  }
  return calls;
}

const binPath = (): string => join(home, ".sentinal", "bin", "sentinal");
const binDir = (): string => join(home, ".sentinal", "bin");

describe("scripts/install.sh", () => {
  it("installs without a token via the public browser_download_url", () => {
    const r = run();
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(binPath(), "utf8")).toBe(BIN_BYTES);
    const calls = curlCalls();
    const all = calls.flat();
    expect(all.some((a) => a.startsWith("Authorization"))).toBe(false);
    expect(all).toContain(browserUrl(ASSET_NAME));
    expect(all).toContain(browserUrl("checksums.txt"));
    expect(all.some((a) => a.includes("/releases/assets/"))).toBe(false);
    expect(r.stdout).toContain("checksum verified");
  }, 20_000);

  it("uses the token and the API asset URL when GITHUB_TOKEN is set", () => {
    const r = run({ GITHUB_TOKEN: "tok123" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(binPath(), "utf8")).toBe(BIN_BYTES);
    const all = curlCalls().flat();
    expect(all).toContain("Authorization: token tok123");
    expect(all).toContain(apiAssetUrl(1002));
    expect(all).toContain(apiAssetUrl(1005));
    expect(all).not.toContain(browserUrl(ASSET_NAME));
  }, 20_000);

  it("accepts GH_TOKEN as the token too", () => {
    const r = run({ GH_TOKEN: "ghtok" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(curlCalls().flat()).toContain("Authorization: token ghtok");
  }, 20_000);

  it("refuses a binary whose checksum does not match", () => {
    writeFileSync(join(fakeDir, "checksums.txt"), checksums("0".repeat(64)));
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("checksum");
    expect(existsSync(binPath())).toBe(false);
    const leftovers = existsSync(binDir())
      ? readdirSync(binDir()).filter((f) => f.startsWith(".sentinal."))
      : [];
    expect(leftovers).toEqual([]);
  }, 20_000);

  it("refuses a binary with no checksums.txt entry", () => {
    writeFileSync(join(fakeDir, "checksums.txt"), `${sha256("x")}  other\n`);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(existsSync(binPath())).toBe(false);
  }, 20_000);

  it("falls back to the public path when the token is rejected (401)", () => {
    const r = run({ GITHUB_TOKEN: "badtok", FAKE_MODE: "reject" });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(readFileSync(binPath(), "utf8")).toBe(BIN_BYTES);
    const calls = curlCalls();
    // Downloads (after the retried release fetch) carry no Authorization.
    const download = calls.find((c) => c.includes(browserUrl(ASSET_NAME)));
    expect(download).toBeDefined();
    expect(download!.some((a) => a.startsWith("Authorization"))).toBe(false);
  }, 20_000);

  it("passes sh -n", () => {
    const r = spawnSync("sh", ["-n", SCRIPT], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it.skipIf(!existsSync("/bin/dash"))(
    "runs under dash",
    () => {
      const r = run({}, "/bin/dash");
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(readFileSync(binPath(), "utf8")).toBe(BIN_BYTES);
    },
    20_000,
  );
});
