import { runGenerateReleaseReviewCommand } from './release-review-cli.js'

process.exitCode = await runGenerateReleaseReviewCommand(process.argv.slice(2))
