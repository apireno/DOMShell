# DOMShell Demo Script

Paste each command one at a time into the DOMShell side panel.
Start on wikipedia.org with the panel open.

## Scene 1: Explore the page (filesystem metaphor)

```
ls --text
```

```
cd main
```

```
tree --depth 2
```

## Scene 2: Find elements by type

```
find --type link --meta --text -n 8
```

```
find --type heading --text
```

## Scene 3: Search and navigate

```
submit search_input "Artificial intelligence"
```

(wait for page to load, then:)

```
find --type heading --text -n 10
```

## Scene 4: Read content

```
cd main
```

```
text -n 500
```

## Scene 5: Extract links

```
extract_links main -n 10
```

## Scene 6: JavaScript discovery

```
functions
```

```
eval document.querySelectorAll('a').length
```

## Scene 7: Iterate over elements (the killer feature)

```
for "find --type heading -n 5" : text {}
```
