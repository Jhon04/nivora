import { ComponentFixture, TestBed } from '@angular/core/testing';

import { EditorComponent } from './editor';
import { TAMANO_BASE } from './tamano-texto';

/**
 * El control de tamaño no toca los títulos.
 *
 * El tamaño de un título lo da su nivel, y el nivel es lo que leen el índice y
 * el plegado. Dejar cambiarlo hacía además que la escala mintiera: poner 12 —el
 * tamaño de base— quita la marca, con lo que el título recuperaba su tamaño de
 * CSS y se AGRANDABA, mientras que 14 lo dejaba en 18.7 px y lo encogía.
 */
describe('tamaño del texto · en títulos', () => {
  let fix: ComponentFixture<EditorComponent>;
  let comp: EditorComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EditorComponent] }).compileComponents();
    fix = TestBed.createComponent(EditorComponent);
    comp = fix.componentInstance;
    fix.detectChanges();
  });

  afterEach(() => fix.destroy());

  /** Deja la nota con un título y un párrafo, y el cursor donde se pida. */
  function nota(dentroDelTitulo: boolean): void {
    comp.editor.commands.setContent('<h2>Titulo</h2><p>parrafo</p>');
    // 1 = dentro del <h2>; el párrafo empieza tras cerrarlo.
    comp.editor.commands.setTextSelection(dentroDelTitulo ? 2 : 12);
  }

  it('reconoce el nivel del título donde está el cursor', () => {
    nota(true);
    expect(comp.nivelTitulo()).toBe(2);

    nota(false);
    expect(comp.nivelTitulo()).toBe(0);
  });

  it('una selección que abarca un título también cuenta', () => {
    // Del título al párrafo: por aquí se colaba el mismo problema.
    comp.editor.commands.setContent('<h1>Titulo</h1><p>parrafo</p>');
    comp.editor.commands.setTextSelection({ from: 2, to: 12 });

    expect(comp.nivelTitulo()).toBe(1);
  });

  it('no deja ponerle tamaño a un título', () => {
    nota(true);

    comp.setTamano(24);

    expect(comp.editor.getHTML()).not.toContain('font-size');
  });

  it('al párrafo sí se lo pone', () => {
    nota(false);

    comp.setTamano(24);

    expect(comp.editor.getHTML()).toContain('font-size: 24pt');
  });

  it('el tamaño de base quita la marca en vez de escribirla', () => {
    nota(false);
    comp.setTamano(24);

    comp.setTamano(TAMANO_BASE);

    // Un texto que vuelve a su tamaño normal queda como el que nunca se tocó.
    expect(comp.editor.getHTML()).not.toContain('font-size');
  });
});
