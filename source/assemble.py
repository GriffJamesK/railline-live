import sys
old=open('/home/user/railline-live/source/app.html').read()
head=old[:old.index('<script>\n/*__GEO__*/')]
main=open('main.js').read().replace('/*__TILEWORKER__*/', open('tileworker.js').read()).replace('/*__RENDERER__*/', open('renderer.js').read())
tpl=head+'<script>\n/*__GEO__*/\n</script>\n<script>\n'+main+'</script>\n</body>\n</html>\n'
open('/home/user/railline-live/source/app.html','w').write(tpl)
open('/home/user/railline-live/index.html','w').write(tpl.replace('/*__GEO__*/',open('../geo.js').read()))
