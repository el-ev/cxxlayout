import CxxLayout, { CxxLayoutModule } from '../wasm/clang-cxx-layout.js';

interface RecordInfo {
    id: string;
    name: string;
}

interface FieldLayout {
    fieldType: 'Simple' | 'Record' | 'VPtr' | 'NVBase';
    name?: string;
    type: string;
    size: number;
    align: number;
    offset: number;
    subFields?: FieldLayout[];
}

interface RecordLayout {
    fieldType: 'Record';
    type: string;
    size: number;
    align: number;
    offset: number;
    subFields: FieldLayout[];
}

class CxxLayoutVisualizer {
    private module: CxxLayoutModule | null = null;
    private records: RecordInfo[] = [];
    private layouts: Map<string, RecordLayout> = new Map();

    private codeEditor: HTMLTextAreaElement;
    private analyzeBtn: HTMLButtonElement;
    private targetSelect: HTMLSelectElement;
    private loading: HTMLElement;
    private error: HTMLElement;
    private recordList: HTMLElement;
    private layoutVisualization: HTMLElement;
    private infoPanel: HTMLElement;
    private infoContent: HTMLElement;
    private clearInfoBtn: HTMLElement;

    private stderr: string = '';

    constructor() {
        this.codeEditor = document.getElementById('codeEditor') as HTMLTextAreaElement;
        this.analyzeBtn = document.getElementById('analyzeBtn') as HTMLButtonElement;
        this.targetSelect = document.getElementById('targetSelect') as HTMLSelectElement;
        this.loading = document.getElementById('loading') as HTMLElement;
        this.error = document.getElementById('error') as HTMLElement;
        this.recordList = document.getElementById('recordList') as HTMLElement;
        this.layoutVisualization = document.getElementById('layoutVisualization') as HTMLElement;
        this.infoPanel = document.getElementById('infoPanel') as HTMLElement;
        this.infoContent = document.getElementById('infoContent') as HTMLElement;
        this.clearInfoBtn = document.getElementById('clearInfo') as HTMLElement;

        this.initializeEventListeners();
        this.loadModule();
    }

    private initializeEventListeners(): void {
        this.analyzeBtn.addEventListener('click', () => this.analyzeCode());
        this.clearInfoBtn.addEventListener('click', () => {
            this.hideInfo();
        });
    }

    private async loadModule(): Promise<void> {
        try {
            this.module = await CxxLayout({
                printErr: (text: string) => {
                    this.stderr += text + '\n';
                }
            }) as CxxLayoutModule;
            console.log('CxxLayout module loaded successfully');
        } catch (err) {
            this.showError('Failed to load CxxLayout module: ' + (err as Error).message);
        }
    }

    private showError(message: string): void {
        this.error.textContent = message;
        this.error.style.display = 'block';
        setTimeout(() => {
            this.error.style.display = 'none';
        }, 5000);
    }

    private showLoading(show: boolean): void {
        this.loading.style.display = show ? 'block' : 'none';
        this.analyzeBtn.disabled = show;
    }

    private showInfo(message: string): void {
        this.infoContent.textContent = message;
        this.infoPanel.style.display = 'flex';
    }

    private hideInfo(): void {
        this.infoPanel.style.display = 'none';
        this.infoContent.textContent = '';
    }

    private async analyzeCode(): Promise<void> {
        if (!this.module) {
            this.showError('Module not loaded yet. Please wait and try again.');
            return;
        }

        const source = this.codeEditor.value.trim();
        if (!source) {
            this.showError('Please enter some C++ code to analyze.');
            return;
        }

        this.showLoading(true);
        this.error.style.display = 'none';
        this.hideInfo();
        this.stderr = '';

        try {
            const args = this.targetSelect.value;
            const encoder = new TextEncoder();

            const argsEncoded = encoder.encode(args);
            const argsPtr = this.module._malloc(argsEncoded.length + 1);
            this.module.stringToUTF8(args, argsPtr, argsEncoded.length + 1);
            this.module._setArgs(argsPtr);
            this.module._free(argsPtr);

            const sourceEncoded = encoder.encode(source);
            const sourcePtr = this.module._malloc(sourceEncoded.length + 1);
            this.module.stringToUTF8(source, sourcePtr, sourceEncoded.length + 1);
            this.module._analyzeSource(sourcePtr);
            this.module._free(sourcePtr);

            const resultPtr = this.module._getRecordList();
            const resultJson = this.module.UTF8ToString(resultPtr);
            this.module._free(resultPtr);
            this.records = JSON.parse(resultJson) as RecordInfo[];
            
            if (this.records.length === 0) {
                this.showError('No records found. Make sure your code contains struct or class definitions.');
                return;
            }

            this.layouts.clear();
            for (const record of this.records) {
                try {
                    let recordId: any = record.id;
                    let layoutPtr: number;
                    try {
                        layoutPtr = this.module._getLayoutForRecord(recordId);
                    } catch (e) {
                        recordId = parseInt(record.id);
                        layoutPtr = this.module._getLayoutForRecord(recordId);
                    }
                    const layoutJson = this.module.UTF8ToString(layoutPtr);
                    this.module._free(layoutPtr);
                    const layout = JSON.parse(layoutJson) as RecordLayout;
                    this.layouts.set(record.id, layout);
                } catch (err) {
                    console.error(`Failed to get layout for record ${record.name} (${record.id}):`, err);
                }
            }

            this.displayResults();
            this.module._cleanup();
            
            if (this.stderr.trim()) {
                this.showInfo(this.stderr.trim());
            }
        } catch (err) {
            this.showError('Analysis failed: ' + (err as Error).message);
        } finally {
            this.showLoading(false);
        }
    }

    private displayResults(): void {
        this.displayRecordList();
        this.displayAllLayouts();
    }

    private displayRecordList(): void {
        const recordItems = this.recordList.querySelector('.record-items') as HTMLElement;
        if (!recordItems) return;
        
        recordItems.innerHTML = '';

        const showAllItem = document.createElement('div');
        showAllItem.className = 'record-item';
        showAllItem.textContent = 'Show All';
        showAllItem.style.fontWeight = '600';
        showAllItem.style.fontStyle = 'italic';
        showAllItem.addEventListener('click', () => {
            this.recordList.querySelectorAll('.record-item').forEach(item => {
                item.classList.remove('selected');
            });
            showAllItem.classList.add('selected');
            this.displayAllLayouts();
        });
        recordItems.appendChild(showAllItem);

        this.records.forEach(record => {
            const recordItem = document.createElement('div');
            recordItem.className = 'record-item';
            recordItem.textContent = `${record.name} (${record.id})`;
            recordItem.addEventListener('click', () => {
                this.recordList.querySelectorAll('.record-item').forEach(item => {
                    item.classList.remove('selected');
                });
                recordItem.classList.add('selected');
                this.displaySingleLayout(record.id);
            });
            recordItems.appendChild(recordItem);
        });

        showAllItem.classList.add('selected');
        this.recordList.style.display = 'block';
    }

    private displayAllLayouts(): void {
        this.layoutVisualization.innerHTML = '';
        this.records.forEach(record => {
            const layout = this.layouts.get(record.id);
            if (layout) {
                const recordElement = this.createRecordElement(record, layout);
                this.layoutVisualization.appendChild(recordElement);
            }
        });
    }

    private displaySingleLayout(recordId: string): void {
        this.layoutVisualization.innerHTML = '';
        const record = this.records.find(r => r.id === recordId);
        const layout = this.layouts.get(recordId);
        if (record && layout) {
            const recordElement = this.createRecordElement(record, layout);
            this.layoutVisualization.appendChild(recordElement);
        }
    }

    private createRecordElement(record: RecordInfo, layout: RecordLayout): HTMLElement {
        const recordBox = document.createElement('div');
        recordBox.className = 'record-box';

        const header = document.createElement('div');
        header.className = 'record-header';
        header.innerHTML = `
            <span>${record.name}</span>
            <span>${layout.size}B • ${layout.align}B align</span>
        `;
        recordBox.appendChild(header);

        if (layout.subFields.length > 0 || layout.size > 0) {
            const memoryBar = this.createMemoryBar(layout);
            recordBox.appendChild(memoryBar);
        }

        if (layout.subFields.length > 0) {
            const fieldHeader = document.createElement('div');
            fieldHeader.className = 'field-header';
            fieldHeader.innerHTML = `
                <span>Field • Type</span>
                <span>Size</span>
                <span>Align</span>
                <span>Offset</span>
            `;
            recordBox.appendChild(fieldHeader);

            layout.subFields.forEach(field => {
                const fieldElement = this.createCompactFieldElement(field);
                recordBox.appendChild(fieldElement);
            });
        }

        this.addHighlightEventListeners(recordBox, layout);

        return recordBox;
    }

    private createMemoryBar(layout: RecordLayout): HTMLElement {
        const memoryBar = document.createElement('div');
        memoryBar.className = 'memory-bar';

        const totalSizeInBytes = layout.size;

        // Create a map of byte offset to field
        const fieldMap = new Map<number, FieldLayout>();
        layout.subFields.forEach(field => {
            for (let i = 0; i < field.size; i++) {
                fieldMap.set(field.offset + i, field);
            }
        });

        for (let i = 0; i < totalSizeInBytes; i++) {
            const byteSquare = document.createElement('div');
            const field = fieldMap.get(i);

            byteSquare.dataset.byteOffset = `${i}`;

            if (field) {
                const fieldTypeClass = this.getFieldTypeClass(field.fieldType).replace('-field', '');
                byteSquare.className = `memory-segment ${fieldTypeClass}`;
                const displayName = field.name || `<${field.fieldType}>`;
                byteSquare.title = `${displayName}: ${field.type} (byte ${i + 1} of ${totalSizeInBytes})`;
                byteSquare.dataset.fieldOffset = `${field.offset}`;
            } else {
                // This is padding
                byteSquare.className = 'memory-segment padding';
                byteSquare.title = `Padding (byte ${i + 1} of ${totalSizeInBytes})`;
            }

            memoryBar.appendChild(byteSquare);
        }

        return memoryBar;
    }

    private createCompactFieldElement(field: FieldLayout, depth: number = 0): HTMLElement {
        const fieldDiv = document.createElement('div');
        fieldDiv.className = `field ${this.getFieldTypeClass(field.fieldType)}`;
        fieldDiv.dataset.fieldOffset = `${field.offset}`;
        if (depth > 0) {
            fieldDiv.style.paddingLeft = `${12 + depth * 12}px`;
        }

        let displayName = field.name || `<${field.fieldType}>`;
        if (field.fieldType === 'VPtr') {
            displayName = 'vtable ptr';
        } else if (field.fieldType === 'NVBase') {
            displayName = `base: ${field.type}`;
        }

        fieldDiv.innerHTML = `
            <div class="field-info">
                <div class="field-name">${displayName}</div>
                <div class="field-type">${field.type}</div>
            </div>
            <div class="field-size">${field.size}B</div>
            <div class="field-align">${field.align}B</div>
            <div class="field-offset">@${field.offset}</div>
        `;

        return fieldDiv;
    }

    private addHighlightEventListeners(recordBox: HTMLElement, layout: RecordLayout): void {
        const fieldElements = Array.from(recordBox.querySelectorAll('.field[data-field-offset]')) as HTMLElement[];
        const memorySegments = Array.from(recordBox.querySelectorAll('.memory-segment[data-byte-offset]')) as HTMLElement[];

        const getFieldFromOffset = (offset: string | undefined | null): FieldLayout | undefined => {
            if (!offset) return undefined;
            return layout.subFields.find(f => f.offset.toString() === offset);
        };

        fieldElements.forEach(fieldEl => {
            fieldEl.addEventListener('mouseover', () => {
                const field = getFieldFromOffset(fieldEl.dataset.fieldOffset);
                if (!field) return;

                fieldEl.classList.add('highlight');
                for (let i = 0; i < field.size; i++) {
                    const byteOffset = field.offset + i;
                    const segment = memorySegments.find(s => s.dataset.byteOffset === byteOffset.toString());
                    segment?.classList.add('highlight');
                }
            });

            fieldEl.addEventListener('mouseout', () => {
                const field = getFieldFromOffset(fieldEl.dataset.fieldOffset);
                if (!field) return;

                fieldEl.classList.remove('highlight');
                for (let i = 0; i < field.size; i++) {
                    const byteOffset = field.offset + i;
                    const segment = memorySegments.find(s => s.dataset.byteOffset === byteOffset.toString());
                    segment?.classList.remove('highlight');
                }
            });
        });

        memorySegments.forEach(segmentEl => {
            segmentEl.addEventListener('mouseover', () => {
                const field = getFieldFromOffset(segmentEl.dataset.fieldOffset);
                if (!field) return;

                const fieldEl = fieldElements.find(fe => fe.dataset.fieldOffset === field.offset.toString());
                fieldEl?.classList.add('highlight');

                for (let i = 0; i < field.size; i++) {
                    const byteOffset = field.offset + i;
                    const segment = memorySegments.find(s => s.dataset.byteOffset === byteOffset.toString());
                    segment?.classList.add('highlight');
                }
            });

            segmentEl.addEventListener('mouseout', () => {
                const field = getFieldFromOffset(segmentEl.dataset.fieldOffset);
                if (!field) return;

                const fieldEl = fieldElements.find(fe => fe.dataset.fieldOffset === field.offset.toString());
                fieldEl?.classList.remove('highlight');

                for (let i = 0; i < field.size; i++) {
                    const byteOffset = field.offset + i;
                    const segment = memorySegments.find(s => s.dataset.byteOffset === byteOffset.toString());
                    segment?.classList.remove('highlight');
                }
            });
        });
    }

    private getFieldTypeClass(fieldType: string): string {
        switch (fieldType) {
            case 'VPtr':
                return 'vptr-field';
            case 'NVBase':
                return 'base-field';
            case 'Simple':
                return 'simple-field';
            case 'Record':
                return 'record-field';
            default:
                return '';
        }
    }
}

// Initialize the visualizer when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new CxxLayoutVisualizer();
});

// Export for potential external use
export { CxxLayoutVisualizer };
