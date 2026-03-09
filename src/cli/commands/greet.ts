/**
 * Sentinal Greet Command
 *
 * Displays the ASCII art banner with version info.
 */

const BLUE = "\x1b[0;34m";
const GREEN = "\x1b[0;32m";
const NC = "\x1b[0m";

const BANNER = `${BLUE}
╔════════════════════════════════════════════════════════════════════╗
║                                                                    ║
║   ███████╗███████╗███╗   ██╗████████╗██╗███╗   ██╗ █████╗ ██╗     ║
║   ██╔════╝██╔════╝████╗  ██║╚══██╔══╝██║████╗  ██║██╔══██╗██║     ║
║   ███████╗█████╗  ██╔██╗ ██║   ██║   ██║██╔██╗ ██║███████║██║     ║
║   ╚════██║██╔══╝  ██║╚██╗██║   ██║   ██║██║╚██╗██║██╔══██║██║     ║
║   ███████║███████╗██║ ╚████║   ██║   ██║██║ ╚████║██║  ██║███████╗║
║   ╚══════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝║
║                                                                    ║
║   Quality Enforcement for TypeScript, Angular, and NestJS         ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
${NC}`;

export function greet(version?: string): void {
  console.log(BANNER);
  if (version) {
    console.log(`${GREEN}  Version: ${version}${NC}`);
    console.log("");
  }
}
