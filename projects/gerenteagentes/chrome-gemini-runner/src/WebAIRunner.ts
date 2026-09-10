/**
 * WebAIRunner — orquestra a execução de tarefas via Chrome + IA web
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { BrowserManager } from './BrowserManager.js';
import { AIPage } from './AIPage.js';
import { PromptBuilder } from './PromptBuilder.js';
import { CommandSanitizer } from './CommandSanitizer.js';
import type { 
  AIProviderConfig,
  WebAIRunnerConfig, 
  CommandResult, 
  ExecutionResult 
} from './types.js';

const execAsync = promisify(exec);

export class WebAIRunner {
  private browserManager: BrowserManager;
  private aiPage: AIPage | null = null;
  private promptBuilder: PromptBuilder;
  private sanitizer: CommandSanitizer;
  private config: Required<WebAIRunnerConfig>;

  constructor(config: WebAIRunnerConfig = {}) {
    this.config = {
      debugPort: config.debugPort ?? 9222,
      headless: config.headless ?? false,
      taskTimeoutMs: config.taskTimeoutMs ?? 30 * 60 * 1000, // 30 min
      commandTimeoutMs: config.commandTimeoutMs ?? 60 * 1000, // 1 min
      pollIntervalMs: config.pollIntervalMs ?? 10 * 1000, // 10s
      // Perfil persistente (mantém login entre restarts)
      userDataDir: config.userDataDir ?? '/tmp/webai-chrome-profile',
    };
    
    this.browserManager = new BrowserManager(this.config);
    this.promptBuilder = new PromptBuilder();
    this.sanitizer = new CommandSanitizer();
  }

  /**
   * Executa uma tarefa usando uma IA web via Chrome
   */
  async execute(
    provider: AIProviderConfig,
    systemPrompt: string,
    userMessage: string,
    terminationCode?: string
  ): Promise<ExecutionResult> {
    const startTime = Date.now();
    const commandsExecuted: CommandResult[] = [];
    const finalTerminationCode = terminationCode ?? `TAREFA_CONCLUIDA_${Date.now()}`;
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 Iniciando WebAIRunner`);
    console.log(`   Provider: ${provider.name}`);
    console.log(`   Código de término: ${finalTerminationCode}`);
    console.log(`${'='.repeat(60)}\n`);
    
    try {
      // Etapa 1: Abrir Chrome
      const page = await this.browserManager.launch();
      this.aiPage = new AIPage(page, provider);
      
      // Etapa 2: Navegar para a IA
      console.log(`📄 Navegando para ${provider.name}...`);
      await this.aiPage.navigate();
      
      // Etapa 3: Enviar system prompt
      console.log('📝 Enviando system prompt...');
      await this.aiPage.sendMessage(systemPrompt);
      await this.aiPage.waitForGenerationComplete();
      
      // Etapa 4: Enviar a mensagem do usuário
      console.log('📋 Enviando mensagem...');
      await this.aiPage.sendMessage(userMessage);
      await this.aiPage.waitForGenerationComplete();
      
      // Etapa 5: Loop de execução
      console.log('🔄 Entrando no loop de execução...\n');
      let lastCommand = '';
      let iteration = 0;
      let finalOutput = '';
      
      while (true) {
        // Timeout total
        if (Date.now() - startTime > this.config.taskTimeoutMs) {
          throw new Error(`Timeout da tarefa (${this.config.taskTimeoutMs}ms)`);
        }
        
        iteration++;
        console.log(`\n--- Iteração ${iteration} ---`);
        
        // Lê o último comando
        const commandBlock = await this.aiPage.readLastCommand();
        
        if (!commandBlock) {
          console.log('⏳ Nenhum comando encontrado, aguardando...');
          await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
          continue;
        }
        
        // Extrai o comando do bloco de código
        const command = this.sanitizer.extractCommand(commandBlock);
        
        console.log(`🔍 Debug - Comando extraído: "${command}"`);
        console.log(`🔍 Debug - Contém TAREFA_CONCLUIDA: ${command.includes('TAREFA_CONCLUIDA')}`);
        
        // Verifica código de término ANTES de executar
        if (command.includes('TAREFA_CONCLUIDA')) {
          console.log('✅ Código de término detectado!');
          break;
        }
        
        // Se é comando novo, executa
        if (command !== lastCommand) {
          console.log(`\n🔥 Novo comando:\n${command}`);
          
          // Sanitiza
          const sanitization = this.sanitizer.sanitize(command);
          if (!sanitization.safe) {
            console.error(`⛔ Comando bloqueado: ${sanitization.reason}`);
            const feedback = `Comando bloqueado por segurança: ${sanitization.reason}. Use outro comando.`;
            await this.aiPage.sendMessage(feedback);
            await this.aiPage.waitForGenerationComplete();
            continue;
          }
          
          // Executa
          const result = await this.executeCommand(command);
          commandsExecuted.push(result);
          
          console.log(`📤 Saída (exit ${result.exitCode}):\n${result.stdout || result.stderr || '(sem saída)'}`);
          
          // Envia resultado para a IA
          const resultPrompt = this.promptBuilder.buildResultPrompt(
            command,
            result.stdout,
            result.stderr,
            result.exitCode
          );
          await this.aiPage.sendMessage(resultPrompt);
          await this.aiPage.waitForGenerationComplete();
          
          lastCommand = command;
          finalOutput = result.stdout || result.stderr;
        } else {
          console.log('⏭️ Comando já executado, aguardando próximo...');
        }
        
        // Aguarda antes de pollar novamente
        await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
      }
      
      // Sucesso
      const totalDurationMs = Date.now() - startTime;
      console.log(`\n${'='.repeat(60)}`);
      console.log(`✅ Tarefa concluída com sucesso!`);
      console.log(`   Comandos executados: ${commandsExecuted.length}`);
      console.log(`   Duração total: ${(totalDurationMs / 1000).toFixed(1)}s`);
      console.log(`${'='.repeat(60)}\n`);
      
      return {
        success: true,
        terminationCode: finalTerminationCode,
        commandsExecuted,
        totalDurationMs,
        output: finalOutput,
      };
      
    } catch (error) {
      const totalDurationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      console.error(`\n${'='.repeat(60)}`);
      console.error(`❌ Tarefa falhou: ${errorMessage}`);
      console.error(`   Comandos executados: ${commandsExecuted.length}`);
      console.error(`   Duração: ${(totalDurationMs / 1000).toFixed(1)}s`);
      console.error(`${'='.repeat(60)}\n`);
      
      return {
        success: false,
        terminationCode: finalTerminationCode,
        commandsExecuted,
        totalDurationMs,
        error: errorMessage,
      };
      
    } finally {
      // Sempre fecha o Chrome
      await this.browserManager.close();
    }
  }

  /**
   * Executa um comando no terminal
   */
  private async executeCommand(command: string): Promise<CommandResult> {
    const startTime = Date.now();
    
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: process.cwd(),
        timeout: this.config.commandTimeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      
      return {
        command,
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: 0,
        executedAt: new Date(),
        durationMs: Date.now() - startTime,
      };
      
    } catch (error: any) {
      return {
        command,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        exitCode: error.code ?? 1,
        executedAt: new Date(),
        durationMs: Date.now() - startTime,
      };
    }
  }
}
