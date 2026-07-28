import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';

import { App } from './app';
import { DocumentosService } from './core/documentos.service';
import { AssetsService } from './core/assets.service';

describe('App', () => {
  beforeEach(async () => {
    // Los servicios reales usan Tauri (`invoke`), que no existe en los tests:
    // se sustituyen por mocks. El componente arranca con la lista vacía.
    const docsMock: Partial<DocumentosService> = {
      listar: () => Promise.resolve([]),
      obtener: () => Promise.resolve(null),
      guardar: (doc) => Promise.resolve(doc),
      eliminar: () => Promise.resolve(),
      buscar: () => Promise.resolve([]),
    };
    const assetsMock: Partial<AssetsService> = {
      iniciar: () => Promise.resolve(),
    };

    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideNoopAnimations(),
        { provide: DocumentosService, useValue: docsMock },
        { provide: AssetsService, useValue: assetsMock },
      ],
    }).compileComponents();
  });

  it('crea la app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('muestra el título de la barra lateral', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Nota Local');
  });

  it('muestra el estado vacío cuando no hay documentos', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.vacio')?.textContent).toContain('Sin documentos');
  });

  it('muestra el marcador cuando no hay documento abierto', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.placeholder')?.textContent).toContain('Selecciona un documento');
  });
});
