import wordmark from './assets/wordmark.png'

export function Brand() {
  return <div className="brand">
    <img src={wordmark} width="100" height="24" alt="Okou" />
    <span>for Even G2</span>
  </div>
}
