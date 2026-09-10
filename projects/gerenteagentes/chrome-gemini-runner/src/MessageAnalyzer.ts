/**
 * MessageAnalyzer - Analisa todas as requisições para encontrar a mensagem do usuário
 */

import puppeteer from 'puppeteer';
import fs from 'fs';

interface CapturedRequest {
  timestamp: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
  response?: {
    status: number;
    headers: Record<string, string>;
    body?: string;
  };
}

async function analyzeMessages() {
  console.log('🔍 Analisando requisições capturadas...\n');

  const captureFile = '/tmp/webai-direct-capture.json';
  
  if (!fs.existsSync(captureFile)) {
    console.log('❌ Arquivo de captura não encontrado');
    return;
  }

  const requests: CapturedRequest[] = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
  
  console.log(`📊 Total de ${requests.length} requisições capturadas\n`);

  // Procurar por requisições que podem conter a mensagem
  const keywords = [
    'pais', 'país', 'seguro', 'atomico', 'atômico', 'ataque', 'morar',
    'ponto de vista', 'qual', 'mais', 'seguranca', 'segurança'
  ];

  console.log('🔎 Procurando por requisições com palavras-chave...\n');

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    
    // Verificar postData
    if (req.postData) {
      const postDataLower = req.postData.toLowerCase();
      const matchedKeywords = keywords.filter(kw => postDataLower.includes(kw));
      
      if (matchedKeywords.length > 0) {
        console.log(`\n📤 Requisição #${i + 1} - POST com palavras-chave`);
        console.log(`   URL: ${req.url.substring(0, 100)}...`);
        console.log(`   Keywords: ${matchedKeywords.join(', ')}`);
        console.log(`   PostData (500 chars): ${req.postData.substring(0, 500)}`);
        
        if (req.response?.body) {
          console.log(`   Response size: ${req.response.body.length} bytes`);
        }
      }
    }
    
    // Verificar response body
    if (req.response?.body) {
      const bodyLower = req.response.body.toLowerCase();
      const matchedKeywords = keywords.filter(kw => bodyLower.includes(kw));
      
      if (matchedKeywords.length > 0) {
        console.log(`\n📥 Requisição #${i + 1} - Response com palavras-chave`);
        console.log(`   URL: ${req.url.substring(0, 100)}...`);
        console.log(`   Keywords: ${matchedKeywords.join(', ')}`);
        console.log(`   Response (500 chars): ${req.response.body.substring(0, 500)}`);
      }
    }
  }

  // Procurar por requisições POST grandes (possíveis mensagens)
  console.log('\n\n📦 Procurando por requisições POST grandes...\n');

  const postRequests = requests.filter(r => r.method === 'POST' && r.postData);
  
  for (let i = 0; i < postRequests.length; i++) {
    const req = postRequests[i];
    const originalIndex = requests.indexOf(req);
    
    if (req.postData && req.postData.length > 200) {
      console.log(`\n📤 Requisição #${originalIndex + 1} - POST grande (${req.postData.length} bytes)`);
      console.log(`   URL: ${req.url.substring(0, 100)}...`);
      console.log(`   PostData (1000 chars): ${req.postData.substring(0, 1000)}`);
      
      if (req.response?.body) {
        console.log(`   Response size: ${req.response.body.length} bytes`);
      }
    }
  }

  // Procurar por requisições com RPC IDs específicos
  console.log('\n\n🔍 Procurando por RPC IDs específicos...\n');

  for (let i = 0; i < requests.length; i++) {
    const req = requests[i];
    
    if (req.url.includes('rpcids=')) {
      const rpcMatch = req.url.match(/rpcids=([^&]+)/);
      if (rpcMatch) {
        const rpcId = rpcMatch[1];
        
        // RPC IDs conhecidos de envio de mensagem
        const messageRpcs = ['ESY5D', 'MaZiqc', 'Te6DCf', 'L5adhe'];
        
        if (messageRpcs.includes(rpcId)) {
          console.log(`\n📡 Requisição #${i + 1} - RPC: ${rpcId}`);
          console.log(`   URL: ${req.url.substring(0, 100)}...`);
          
          if (req.postData) {
            console.log(`   PostData (1000 chars): ${req.postData.substring(0, 1000)}`);
          }
          
          if (req.response?.body) {
            console.log(`   Response size: ${req.response.body.length} bytes`);
            console.log(`   Response (500 chars): ${req.response.body.substring(0, 500)}`);
          }
        }
      }
    }
  }
}

analyzeMessages().catch(console.error);
