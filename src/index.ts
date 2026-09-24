import { Command } from 'commander'
import { VERSION } from './version'
import { setVerbose } from './core/log'
import { MbError } from './core/errors'
import { run } from './commands/run'
import { loginCommand } from './commands/login'
import { logoutCommand } from './commands/logout'
import { doctorCommand } from './commands/doctor'

const program = new Command()

program
  .name('mb-ai')
  .description('MerchantBots harness launcher — wraps Claude Code with the mb-ai profile.')
  .version(VERSION)
  .option('--backend-url <url>', 'override the backend URL (also MB_AI_BACKEND_URL)')
  .option('--verbose', 'verbose logging')
  .hook('preAction', (thisCmd) => {
    if (thisCmd.opts().verbose) setVerbose(true)
  })

program
  .command('login')
  .description('Log in to a backend and store a bearer token')
  .action(async () => loginCommand(program.opts()))

program
  .command('logout')
  .description('Clear the stored token for a backend')
  .action(async () => logoutCommand(program.opts()))

program
  .command('doctor')
  .description('Show diagnostics (backend, auth, claude)')
  .action(async () => doctorCommand(program.opts()))

// no subcommand → the run flow
program.action(async () => run(program.opts()))

program.parseAsync().catch((e: unknown) => {
  const message = e instanceof MbError ? e.message : e instanceof Error ? e.message : String(e)
  const exitCode = e instanceof MbError ? e.exitCode : 1
  console.error(`\nmb-ai: ${message}`)
  process.exit(exitCode)
})
