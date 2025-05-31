# Free My X

Goals:

- OAuth Client for X with Privacy Policy and terms of use that allows users to approve third parties to access their data
- Endpoint to check a user
- Endpoint to get a list of all users that have approved

| Summary                                                    | Prompt it                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main application overview including goals and openapi spec | [![](https://b.lmpify.com/overview)](https://lmpify.com?q=https%3A%2F%2Fuuithub.com%2Fjanwilmake%2Ffreemyx%2Ftree%2Fmain%3FpathPatterns%3DREADME.md%26pathPatterns%3DTODO.md%26pathPatterns%3Dopenapi.json%0A%0ASummarize%20the%20main%20goals%2C%20features%2C%20and%20deployment%20process%20of%20this%20application.)                                                                      |
| Frontend pages for user interaction                        | [![](https://b.lmpify.com/web_ui)](https://lmpify.com?q=https%3A%2F%2Fuuithub.com%2Fjanwilmake%2Ffreemyx%2Ftree%2Fmain%3FpathPatterns%3Dindex.html%26pathPatterns%3Dprivacy.html%26pathPatterns%3Dterms.html%26pathPatterns%3Dterms.html.md%0A%0ADescribe%20the%20user%20interface%2C%20design%20principles%2C%20and%20privacy%2Fterms%20information%20presented%20in%20these%20pages.)       |
| Cloudflare Worker backend                                  | [![](https://b.lmpify.com/api_server)](https://lmpify.com?q=https%3A%2F%2Fuuithub.com%2Fjanwilmake%2Ffreemyx%2Ftree%2Fmain%3FpathPatterns%3Dmain.ts%0A%0AExplain%20the%20API%20endpoints%2C%20authentication%20middleware%2C%20data%20storage%2C%20and%20user%20liberation%20logic%20implemented.)                                                                                            |
| Deployment and configuration files for Cloudflare Worker   | [![](https://b.lmpify.com/deployment)](https://lmpify.com?q=https%3A%2F%2Fuuithub.com%2Fjanwilmake%2Ffreemyx%2Ftree%2Fmain%3FpathPatterns%3Dwrangler.jsonc%26pathPatterns%3Dpackage.json%26pathPatterns%3D.dev.vars.example%26pathPatterns%3D.gitignore%26pathPatterns%3D.assetsignore%0A%0AOutline%20the%20deployment%20configuration%2C%20environment%20variables%2C%20and%20dependencies.) |

# FAQ

How to build an app that uses freemyx to first let the user approve it? https://lmpify.com/httpsuuithubcom-7293ys0

# Development

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/janwilmake/freemyx) <!-- for easy deployment, ensure to add this into the readme of the created project -->
