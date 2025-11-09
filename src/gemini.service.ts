import { Injectable, signal } from '@angular/core';
import { GenerateContentResponse, GoogleGenAI, HarmBlockThreshold, HarmCategory } from '@google/genai';
import { TranslationMode } from './app.component';

export interface TranslationResult {
  original: string;
  translation: string;
}

@Injectable({
  providedIn: 'root',
})
export class GeminiService {
  private genAI: GoogleGenAI | null = null;
  public apiKeySignal = signal<string>('');
  
  constructor() {
    // CRITICAL: The API key is sourced from the environment as per unbreakable rules.
    // The UI input is for user experience simulation only.
    const apiKey = process.env.API_KEY;
    if (apiKey) {
      this.genAI = new GoogleGenAI({ apiKey });
      this.apiKeySignal.set('******'); // Indicate that key is loaded
    } else {
      console.error("API_KEY environment variable not set.");
    }
  }

  private async fileToGenerativePart(file: File): Promise<{ inlineData: { data: string; mimeType: string; }; }> {
    const base64EncodedDataPromise = new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.readAsDataURL(file);
    });
    return {
      inlineData: {
        data: await base64EncodedDataPromise,
        mimeType: file.type,
      },
    };
  }

  async translateMangaPage(imageFile: File, wikiUrl: string, mode: TranslationMode): Promise<string> {
    if (!this.genAI) {
      throw new Error('Gemini AI client is not initialized. Check API Key.');
    }

    const model = 'gemini-2.5-flash';
    
    const imagePart = await this.fileToGenerativePart(imageFile);
    
    let modeInstruction = '';
    switch (mode) {
      case 'short':
        modeInstruction = `Provide a natural, accurate, and context-aware Vietnamese translation for each piece of text. The translation should be concise, using short, easy-to-understand sentences, suitable for quick reading.`;
        break;
      case 'full':
        modeInstruction = `Provide a natural, accurate, and context-aware Vietnamese translation for each piece of text. Ensure the full and complete meaning of the original English text is preserved, even if it requires slightly longer sentences.`;
        break;
      case 'bold':
        modeInstruction = `Provide a creative and daring Vietnamese translation for each piece of text. Feel free to use modern slang, idioms, and a bold, inventive style that captures the spirit of the characters, even if it deviates slightly from a literal translation. The goal is a translation that is exciting and fresh.`;
        break;
      case 'in-depth':
      default:
        modeInstruction = `Provide a natural, accurate, and context-aware Vietnamese translation for each piece of text. Deeply analyze the provided context to maintain the original character's tone, emotion, and specific manner of speaking for the most nuanced and high-quality translation possible.`;
        break;
    }

    const prompt = `You are an expert manga translator, specializing in English to Vietnamese translations.
    CONTEXT: Use the information from this Wikipedia or Fandom page to understand the characters' personalities, relationships, and the overall tone of the story: ${wikiUrl}
    TASK:
    1.  Carefully examine the provided manga page image.
    2.  Extract all English text from the speech bubbles and sound effects.
    3.  ${modeInstruction}
    4.  Format your response as plain text. For each bubble, provide the original English text on one line, and the Vietnamese translation on the next line. Separate each bubble's translation with a blank line.
    
    Example:
    English: You're late!
    Vietnamese: Cậu đến muộn đó!
    
    English: What's going on here?
    Vietnamese: Chuyện gì đang xảy ra ở đây vậy?
    `;

    try {
      const response: GenerateContentResponse = await this.genAI.models.generateContent({
          model: model,
          contents: { parts: [
            { text: prompt },
            imagePart
          ] },
          config: {
            safetySettings: [
              { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
              { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
          }
      });
      return response.text;
    } catch (error: any) {
      console.error('Error translating manga page:', error);
      if (error && error.toString().includes('API key not valid')) {
          return "Translation failed: The provided API key is invalid. Please check your key and try again.";
      }
      return `Translation failed. Please check the console for details. Error: ${error.message}`;
    }
  }
}