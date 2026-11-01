// A side-effect CSS import (`import './theme.css'`) has no exports to type; this is the
// minimal ambient declaration for that, not the full `vite/client` surface, which also
// brings in import.meta.env/glob typings this project has no use for.
declare module '*.css';
