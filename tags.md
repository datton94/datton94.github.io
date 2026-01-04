---
layout: default
title: Tags
permalink: /tags/
---

<h1>Tags</h1>

{% assign tags = site.tags | sort %}
{% for tag in tags %}
  {% assign tag_name = tag[0] %}
  <h2 id="{{ tag_name | slugify }}">{{ tag_name }}</h2>
  <ul>
    {% for post in tag[1] %}
      <li>
        <a href="{{ post.url | relative_url }}">{{ post.title }}</a>
        <small>{{ post.date | date: "%Y-%m-%d" }}</small>
      </li>
    {% endfor %}
  </ul>
{% endfor %}
