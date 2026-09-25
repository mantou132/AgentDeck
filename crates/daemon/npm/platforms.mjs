export const platforms = [
  { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin' },
  { suffix: 'darwin-x64', os: 'darwin', cpu: 'x64', target: 'x86_64-apple-darwin' },
  { suffix: 'linux-x64-gnu', os: 'linux', cpu: 'x64', libc: 'glibc', target: 'x86_64-unknown-linux-gnu' },
  { suffix: 'windows-x64', os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc' },
];

export function currentPlatform() {
  const platform = platforms.find(({ os, cpu }) => os === process.platform && cpu === process.arch);
  if (!platform || (platform.libc && !process.report.getReport().header.glibcVersionRuntime)) {
    throw new Error(`Unsupported platform: ${process.platform}/${process.arch}. Linux requires x64 with glibc.`);
  }
  return platform;
}
