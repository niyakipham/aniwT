import { Component, ChangeDetectionStrategy, signal, inject, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GeminiService } from './gemini.service';

// This tells TypeScript that these are loaded globally from the CDN
declare var JSZip: any;
declare var pdfjsLib: any;

type AppStatus = 'idle' | 'loading-file' | 'file-loaded' | 'translating' | 'success' | 'error';

export type TranslationMode = 'short' | 'full' | 'bold' | 'in-depth';

interface Page {
  pageNum: number;
  file: File;
  previewUrl: string;
  translation?: string[];
  isTranslating: boolean;
  error?: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private geminiService = inject(GeminiService);

  status = signal<AppStatus>('idle');
  uploadedFile = signal<File | null>(null);
  fileName = signal<string>('');
  
  pages = signal<Page[]>([]);
  totalPageCount = signal<number>(0);
  translatedPageCount = signal<number>(0);
  
  wikiUrl = signal<string>('');
  translationMode = signal<TranslationMode>('in-depth');
  
  isApiKeyModalVisible = signal<boolean>(true);
  apiKeyInput = signal<string>('');

  errorMessage = signal<string>('');
  isDragging = signal(false);

  constructor() {
    effect(() => {
        if (this.geminiService.apiKeySignal()) {
            this.isApiKeyModalVisible.set(false);
        }
    });

    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
    }
  }

  saveApiKey() {
    if (this.apiKeyInput().trim()) {
      this.isApiKeyModalVisible.set(false);
    } else {
      this.errorMessage.set('Please enter a key to proceed.');
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(false);
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    this.isDragging.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFile(files[0]);
    }
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFile(input.files[0]);
    }
  }

  private async handleFile(file: File) {
    this.reset();
    this.status.set('loading-file');
    this.uploadedFile.set(file);
    this.fileName.set(file.name);

    const fileExtension = file.name.toLowerCase().split('.').pop();

    if (fileExtension === 'cbz') {
      await this.handleCbz(file);
    } else if (fileExtension === 'pdf') {
      await this.handlePdf(file);
    } else {
      this.status.set('error');
      this.errorMessage.set('Invalid file type. Please upload a .cbz or .pdf file.');
    }
  }

  private async handleCbz(file: File) {
    try {
      const zip = await JSZip.loadAsync(file);
      const imageFiles = Object.keys(zip.files).filter(name => 
        !zip.files[name].dir && /\.(jpe?g|png|gif|webp)$/i.test(name)
      ).sort();

      if (imageFiles.length === 0) {
        throw new Error('No images found in the .cbz file.');
      }

      this.totalPageCount.set(imageFiles.length);
      const extractedPages: Page[] = [];
      let pageNum = 1;
      for (const imageName of imageFiles) {
        const imageFile = zip.file(imageName);
        if (imageFile) {
          const blob = await imageFile.async('blob');
          const fileType = this.getImageMimeType(imageName);
          const pageFile = new File([blob], imageName, { type: fileType });
          
          extractedPages.push({
            pageNum,
            file: pageFile,
            previewUrl: URL.createObjectURL(blob),
            isTranslating: false,
          });
          pageNum++;
        }
      }
      this.pages.set(extractedPages);
      this.status.set('file-loaded');

    } catch (e) {
      this.status.set('error');
      this.errorMessage.set('Failed to read the .cbz file. It might be corrupted.');
      console.error(e);
    }
  }

  private async handlePdf(file: File) {
    if (typeof pdfjsLib === 'undefined') {
        this.status.set('error');
        this.errorMessage.set('PDF library is not available. Please check your connection.');
        return;
    }
    try {
      const loadingTask = pdfjsLib.getDocument(URL.createObjectURL(file));
      const pdf = await loadingTask.promise;
      this.totalPageCount.set(pdf.numPages);

      const extractedPages: Page[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.5 });
        
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const context = canvas.getContext('2d');
        
        if (context) {
          await page.render({ canvasContext: context, viewport: viewport }).promise;
          const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
          
          if(blob) {
            const pageFile = new File([blob], `page_${i}.png`, { type: 'image/png' });
            extractedPages.push({
              pageNum: i,
              file: pageFile,
              previewUrl: URL.createObjectURL(blob),
              isTranslating: false,
            });
          }
        }
      }
      this.pages.set(extractedPages);
      this.status.set('file-loaded');

    } catch (e) {
      this.status.set('error');
      this.errorMessage.set('Failed to read the .pdf file. It might be corrupted or protected.');
      console.error(e);
    }
  }

  private getImageMimeType(filename: string): string {
    const extension = filename.split('.').pop()?.toLowerCase();
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'application/octet-stream';
    }
  }

  async translateAll() {
    const url = this.wikiUrl().trim();
    const mode = this.translationMode();

    if (this.pages().length === 0) {
      this.status.set('error');
      this.errorMessage.set('No pages loaded to translate.');
      return;
    }
    if (!url) {
      this.status.set('error');
      this.errorMessage.set('Please provide a Wikipedia or Fandom URL for context.');
      return;
    }
    if (!this.geminiService.apiKeySignal()) {
      this.status.set('error');
      this.errorMessage.set('API Key is not configured. Cannot translate.');
      this.isApiKeyModalVisible.set(true);
      return;
    }

    this.status.set('translating');
    this.translatedPageCount.set(0);
    this.errorMessage.set('');

    const pagesToTranslate = this.pages();

    for (const page of pagesToTranslate) {
      try {
        // Mark current page as translating
        this.pages.update(currentPages => 
          currentPages.map(p => p.pageNum === page.pageNum ? { ...p, isTranslating: true, error: undefined } : p)
        );

        const resultText = await this.geminiService.translateMangaPage(page.file, url, mode);
        
        // Update page with translation
        this.pages.update(currentPages => 
          currentPages.map(p => p.pageNum === page.pageNum ? { ...p, isTranslating: false, translation: resultText.split('\n').filter(line => line.trim() !== '') } : p)
        );
        this.translatedPageCount.update(c => c + 1);

      } catch (e: any) {
        this.pages.update(currentPages => 
          currentPages.map(p => p.pageNum === page.pageNum ? { ...p, isTranslating: false, error: e.message || 'An unknown error occurred' } : p)
        );
        this.errorMessage.set(`Failed on page ${page.pageNum}. See details above.`);
        console.error(`Error on page ${page.pageNum}:`, e);
        // Optional: stop on first error
        // this.status.set('error');
        // return;
      }
    }
    this.status.set('success');
  }
  
  reset() {
    this.status.set('idle');
    this.uploadedFile.set(null);
    this.fileName.set('');
    this.pages.set([]);
    this.totalPageCount.set(0);
    this.translatedPageCount.set(0);
    this.wikiUrl.set('');
    this.translationMode.set('in-depth');
    this.errorMessage.set('');
  }
}