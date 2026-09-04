import { runGenerateCommand } from './release-evidence-cli.js'

process.exitCode = await runGenerateCommand(process.argv.slice(2))
