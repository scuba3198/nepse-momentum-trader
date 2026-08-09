@module("./styles.css?inline")
external styles: string = "default"

let () = {
  let _ = styles
  switch ReactDOM.querySelector("#root") {
  | Some(root) =>
    ReactDOM.Client.createRoot(root)->ReactDOM.Client.Root.render(
      <RecoveryBoundary>
        <App />
      </RecoveryBoundary>,
    )
  | None => ()
  }
}
